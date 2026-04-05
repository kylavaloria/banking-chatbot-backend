// ─────────────────────────────────────────────────────────────────────────────
// Conversation Manager — Slice 1 + Slice 2 + Slice 3
// Slice 3 additions:
//   - hybrid branch: triage + action on operational component only
//   - topic_switch: detected and flagged in OrchestratorResult
// ─────────────────────────────────────────────────────────────────────────────

import type { PipelineContext, OrchestratorResult } from '../contracts/orchestration.contract';
import type { ClarificationContext }                from '../agents/intent.agent';

import { triageIntent }     from '../agents/triage.agent';
import { decide }           from '../agents/policy.agent';
import { executeAction }    from '../agents/action.agent';
import { generateResponse } from '../agents/response.agent';

const PLACEHOLDER_INFORMATIONAL =
  'Our team will provide you with the relevant information on that topic shortly.';

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

  // ── Hybrid branch (Slice 3) ───────────────────────────────────────────────
  // Run triage on the operational component; informational component is
  // answered with a placeholder. No case/ticket for informational part.
  if (intent_result.flags.hybrid) {
    const operationalComponent = intent_result.issue_components.find(
      c => c.intent_group === 'operational'
    );

    if (!operationalComponent) {
      // Hybrid flag set but no operational component — fall back to clarification
      const fallbackIntent = { ...intent_result, flags: { ...intent_result.flags, hybrid: false, ambiguous: true } };
      const policyOutput   = decide(fallbackIntent);
      const actionResult   = await executeAction({
        context: conversation, intentResult: fallbackIntent,
        policyDecision: policyOutput.decision, plan: policyOutput.plan,
      });
      const assistantText = generateResponse({ actionResult, intentResult: fallbackIntent, policyOutput, clarificationContext });
      ctx.assistant_text = assistantText;
      return {
        assistant_text: assistantText, response_mode: actionResult.response_mode,
        session_id: conversation.session_id, message_id: '',
        case_id: actionResult.case_id ?? null, ticket_id: actionResult.ticket_id ?? null,
      };
    }

    // Triage the operational component only
    const syntheticIntent = { ...intent_result, intent_type: operationalComponent.intent_type, flags: { ...intent_result.flags, hybrid: false } };
    const triageResult    = triageIntent(syntheticIntent);
    ctx.triage_result     = triageResult;

    const policyOutput  = decide(syntheticIntent, triageResult);
    ctx.policy_decision = policyOutput.decision;

    const actionResult = await executeAction({
      context: conversation, intentResult: syntheticIntent,
      triageResult, policyDecision: policyOutput.decision, plan: policyOutput.plan,
    });
    ctx.action_result = actionResult;

    const assistantText = generateResponse({
      actionResult, intentResult: syntheticIntent, triageResult, policyOutput,
      clarificationContext, hybridInformationalAnswer: PLACEHOLDER_INFORMATIONAL,
    });
    ctx.assistant_text = assistantText;

    const result: OrchestratorResult = {
      assistant_text: assistantText,
      response_mode:  actionResult.response_mode,
      session_id:     conversation.session_id,
      message_id:     '',
      case_id:        actionResult.case_id   ?? null,
      ticket_id:      actionResult.ticket_id ?? null,
    };
    if (process.env.NODE_ENV !== 'production') {
      result.debug = { intent_result, triage_result: triageResult,
                       policy_decision: policyOutput.decision, action_result: actionResult };
    }
    return result;
  }

  // ── Standard pipeline (Slice 1 / Slice 2 / Slice 3 multi-issue + topic switch) ──

  // Step 1: Triage (operational and multi-issue)
  let triageResult = ctx.triage_result;
  if (intent_result.intent_group === 'operational') {
    triageResult    = triageIntent(intent_result);
    ctx.triage_result = triageResult;
  }

  // Step 2: Policy
  const policyOutput  = decide(intent_result, triageResult);
  ctx.policy_decision = policyOutput.decision;

  // Step 3: Action
  const actionResult = await executeAction({
    context: conversation, intentResult: intent_result,
    triageResult, policyDecision: policyOutput.decision, plan: policyOutput.plan,
  });
  ctx.action_result = actionResult;

  // Step 4: Response
  const assistantText = generateResponse({
    actionResult, intentResult: intent_result, triageResult, policyOutput,
    clarificationContext, topicSwitched,
  });
  ctx.assistant_text = assistantText;

  const result: OrchestratorResult = {
    assistant_text: assistantText,
    response_mode:  actionResult.response_mode,
    session_id:     conversation.session_id,
    message_id:     '',
    case_id:        actionResult.case_id   ?? null,
    ticket_id:      actionResult.ticket_id ?? null,
    ticket_ids:     actionResult.created_ticket_ids?.length
                      ? actionResult.created_ticket_ids : undefined,
    topic_switched: topicSwitched || undefined,
  };

  if (process.env.NODE_ENV !== 'production') {
    result.debug = { intent_result, triage_result: triageResult,
                     policy_decision: policyOutput.decision, action_result: actionResult };
  }
  return result;
}