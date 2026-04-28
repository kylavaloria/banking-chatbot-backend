// ─────────────────────────────────────────────────────────────────────────────
// Conversation Manager — Slice 5: RAG for informational branch
// ─────────────────────────────────────────────────────────────────────────────

import type { PipelineContext, OrchestratorResult, ActiveCaseContext } from '../contracts/orchestration.contract';
import type { ClarificationContext }                from '../agents/intent.agent';
import type { EmotionResult }                       from '../contracts/emotion.contract';
import type { IntentResult }                        from '../contracts/intent.contract';
import type { ActionResult, CaseStage }             from '../contracts/action.contract';

import { triageIntentAsync }   from '../agents/triage.agent';
import { decide }              from '../agents/policy.agent';
import { executeAction }       from '../agents/action.agent';
import { generateResponse, FOLLOW_UP_ASSISTANT_FALLBACK } from '../agents/response.agent';
import { answerInformational } from '../rag/index';
import { updateCaseSummary }   from '../services/case.service';
import { env }                 from '../config/env';

function buildFollowUpSummary(
  activeCase: ActiveCaseContext,
  intentResult: IntentResult,
  userMessage: string
): string {
  const existing = activeCase.summary ?? '';
  const truncatedMessage = userMessage.slice(0, 200);

  if (intentResult.intent_type === 'complaint_follow_up') {
    return `${existing} Customer followed up: "${truncatedMessage}"`;
  }

  if (
    intentResult.intent_type === 'unclear_issue' ||
    intentResult.intent_type === 'general_complaint'
  ) {
    return `${existing} Customer expressed continued concern: "${truncatedMessage}"`;
  }

  return `${existing} Updated: ${truncatedMessage}`;
}

function emotionIntensityLevel(e: EmotionResult): 'low' | 'medium' | 'high' {
  if (e.intensity >= 0.7) return 'high';
  if (e.intensity >= 0.4) return 'medium';
  return 'low';
}

export async function runConversationManager(
  ctx: PipelineContext,
  clarificationContext?: ClarificationContext | null
): Promise<OrchestratorResult> {
  const { intent_result, conversation } = ctx;

  if (!intent_result) {
    throw { status: 500, message: 'ConversationManager: intent_result missing.' };
  }

  const topicSwitched = intent_result.flags.topic_switch &&
    conversation.active_case !== null &&
    intent_result.intent_group === 'operational';

  // ── Hybrid branch ─────────────────────────────────────────────────────────
  if (intent_result.flags.hybrid) {
    const operationalComponent = intent_result.issue_components.find(
      c => c.intent_group === 'operational'
    );

    if (!operationalComponent) {
      const fallbackIntent = {
        ...intent_result,
        flags: { ...intent_result.flags, hybrid: false, ambiguous: true },
      };
      const policyOutput = decide(fallbackIntent);
      const actionResult = await executeAction({
        context: conversation, intentResult: fallbackIntent,
        policyDecision: policyOutput.decision, plan: policyOutput.plan,
      });
      const assistantText = await generateResponse({
        actionResult, intentResult: fallbackIntent, policyOutput, clarificationContext,
      });
      ctx.assistant_text = assistantText;
      return {
        assistant_text: assistantText, response_mode: actionResult.response_mode,
        session_id: conversation.session_id, message_id: '',
        case_id: actionResult.case_id ?? null, ticket_id: actionResult.ticket_id ?? null,
      };
    }

    // Slice 5: RAG for the informational component of hybrid messages
    const informationalComponent = intent_result.issue_components.find(
      c => c.intent_group === 'informational'
    );
    let hybridInformationalAnswer =
      'Our team will provide you with the relevant information on that topic shortly.';

    if (informationalComponent && env.NODE_ENV !== 'test') {
      try {
        const ragAnswer = await answerInformational(
          informationalComponent.summary || (ctx.user_message ?? '')
        );
        hybridInformationalAnswer = ragAnswer.answer_text;
      } catch (err) {
        console.warn('[ConversationManager] RAG failed for hybrid informational component', err instanceof Error ? err.message : err);
      }
    }

    const syntheticIntent = {
      ...intent_result,
      intent_type: operationalComponent.intent_type,
      flags: { ...intent_result.flags, hybrid: false },
    };

    const triageResult  = await triageIntentAsync(syntheticIntent, ctx.user_message ?? '', ctx.emotion_result);
    ctx.triage_result   = triageResult;

    const policyOutput  = decide(syntheticIntent, triageResult);
    ctx.policy_decision = policyOutput.decision;

    const actionResult = await executeAction({
      context: conversation, intentResult: syntheticIntent,
      triageResult, policyDecision: policyOutput.decision, plan: policyOutput.plan,
    });
    ctx.action_result = actionResult;

    const assistantText = await generateResponse({
      actionResult, intentResult: syntheticIntent, triageResult, policyOutput,
      clarificationContext, hybridInformationalAnswer,
      emotionLabel: ctx.emotion_result?.label,
    });
    ctx.assistant_text = assistantText;

    const result: OrchestratorResult = {
      assistant_text: assistantText, response_mode: actionResult.response_mode,
      session_id: conversation.session_id, message_id: '',
      case_id: actionResult.case_id ?? null, ticket_id: actionResult.ticket_id ?? null,
      emotion_label:     ctx.emotion_result?.label,
      emotion_intensity: ctx.emotion_result ? emotionIntensityLevel(ctx.emotion_result) : undefined,
    };
    if (process.env.NODE_ENV !== 'production') {
      result.debug = {
        intent_result, triage_result: triageResult,
        policy_decision: policyOutput.decision, action_result: actionResult,
      };
    }
    return result;
  }

  // ── Standard pipeline ─────────────────────────────────────────────────────

  let triageResult = ctx.triage_result;
  if (intent_result.intent_group === 'operational') {
    triageResult      = await triageIntentAsync(intent_result, ctx.user_message ?? '', ctx.emotion_result);
    ctx.triage_result = triageResult;
  }

  const policyOutput  = decide(intent_result, triageResult);
  ctx.policy_decision = policyOutput.decision;

  const activeCase = conversation.active_case;
  const isFollowUpCase =
    intent_result.consistency_with_active_case === 'same_case' &&
    activeCase !== null &&
    activeCase.status !== 'resolved' &&
    activeCase.status !== 'closed' &&
    activeCase.stage !== 'awaiting_card_block_confirmation' &&
    !intent_result.flags.multi_issue &&
    intent_result.intent_group === 'operational' &&
    !intent_result.flags.malicious_input;

  if (isFollowUpCase && activeCase) {
    const updatedSummary = buildFollowUpSummary(
      activeCase,
      intent_result,
      ctx.user_message ?? ''
    );
    await updateCaseSummary(activeCase.case_id, updatedSummary);

    const followUpActionResult: ActionResult = {
      response_mode:          'follow_up_update',
      case_id:                activeCase.case_id,
      ticket_id:              null,
      created_ticket_ids:     [],
      stage_after_action:     activeCase.stage as CaseStage,
      informational_payload:  null,
      clarification_payload:  null,
      refusal_payload:        null,
      execution_summary:      ['follow_up_case_summary_update'],
    };
    ctx.action_result = followUpActionResult;

    let assistantText: string;
    try {
      assistantText = await generateResponse({
        actionResult:         followUpActionResult,
        intentResult:         intent_result,
        triageResult,
        policyOutput,
        clarificationContext,
        isFollowUp:           true,
        topicSwitched:        false,
        emotionLabel:         ctx.emotion_result?.label,
        emotionResult:        ctx.emotion_result ?? null,
        userMessage:          ctx.user_message ?? '',
        activeCase:           activeCase,
      });
    } catch (err) {
      console.warn(
        '[ConversationManager] generateResponse failed in follow-up branch',
        err instanceof Error ? err.message : err
      );
      assistantText = FOLLOW_UP_ASSISTANT_FALLBACK;
    }
    const trimmed = assistantText.trim();
    assistantText = trimmed.length > 0 ? trimmed : FOLLOW_UP_ASSISTANT_FALLBACK;

    ctx.assistant_text = assistantText;

    const followUpResult: OrchestratorResult = {
      assistant_text:    assistantText,
      response_mode:     'follow_up_update',
      session_id:        conversation.session_id,
      message_id:        '',
      case_id:           activeCase.case_id,
      ticket_id:         null,
      emotion_label:     ctx.emotion_result?.label,
      emotion_intensity: ctx.emotion_result
        ? emotionIntensityLevel(ctx.emotion_result)
        : undefined,
    };
    if (process.env.NODE_ENV !== 'production') {
      followUpResult.debug = {
        intent_result,
        triage_result:   triageResult,
        policy_decision: policyOutput.decision,
        action_result:   followUpActionResult,
      };
    }
    return followUpResult;
  }

  const actionResult = await executeAction({
    context: conversation, intentResult: intent_result,
    triageResult, policyDecision: policyOutput.decision, plan: policyOutput.plan,
  });
  ctx.action_result = actionResult;

  // ── Slice 5: RAG for pure informational queries ───────────────────────────
  let ragAnswerText: string | null = null;
  if (
    intent_result.intent_group === 'informational' &&
    actionResult.response_mode === 'informational' &&
    env.NODE_ENV !== 'test'
  ) {
    try {
      const ragAnswer = await answerInformational(ctx.user_message ?? '');
      if (!ragAnswer.is_fallback) {
        ragAnswerText = ragAnswer.answer_text;
      }
    } catch (err) {
      console.warn('[ConversationManager] RAG failed', err instanceof Error ? err.message : err);
    }
  }

  // Inject RAG answer into the action result if we got one
  const enrichedActionResult = ragAnswerText
    ? {
      ...actionResult,
      informational_payload: {
        answer_text: ragAnswerText,
        source_mode: 'rag' as const,
      },
    }
    : actionResult;

  const assistantText = await generateResponse({
    actionResult:  enrichedActionResult,
    intentResult:  intent_result,
    triageResult,
    policyOutput,
    clarificationContext,
    topicSwitched,
    emotionLabel: ctx.emotion_result?.label,
  });
  ctx.assistant_text = assistantText;

  const result: OrchestratorResult = {
    assistant_text: assistantText,
    response_mode:  enrichedActionResult.response_mode,
    session_id:     conversation.session_id,
    message_id:     '',
    case_id:        enrichedActionResult.case_id  ?? null,
    ticket_id:      enrichedActionResult.ticket_id ?? null,
    ticket_ids:     enrichedActionResult.created_ticket_ids?.length
      ? enrichedActionResult.created_ticket_ids : undefined,
    topic_switched:    topicSwitched || undefined,
    emotion_label:     ctx.emotion_result?.label,
    emotion_intensity: ctx.emotion_result ? emotionIntensityLevel(ctx.emotion_result) : undefined,
  };

  if (process.env.NODE_ENV !== 'production') {
    result.debug = {
      intent_result, triage_result: triageResult,
      policy_decision: policyOutput.decision, action_result: enrichedActionResult,
    };
  }
  return result;
}
