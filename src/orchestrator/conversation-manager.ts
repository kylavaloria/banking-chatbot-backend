// ─────────────────────────────────────────────────────────────────────────────
// Conversation Manager — Slice 5: RAG for informational branch
// ─────────────────────────────────────────────────────────────────────────────

import type { PipelineContext, OrchestratorResult } from '../contracts/orchestration.contract';
import type { ClarificationContext }                from '../agents/intent.agent';
import type { EmotionResult }                       from '../contracts/emotion.contract';

import { triageIntentAsync }   from '../agents/triage.agent';
import { decide }              from '../agents/policy.agent';
import { executeAction }       from '../agents/action.agent';
import { generateResponse }    from '../agents/response.agent';
import { answerInformational } from '../rag/index';
import { env }                 from '../config/env';

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
