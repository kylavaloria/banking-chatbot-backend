// ─────────────────────────────────────────────────────────────────────────────
// Conversation Manager — Phase 2, Slice 1 + Slice 2
// Slice 2: accepts and threads clarification context into Response Agent
// ─────────────────────────────────────────────────────────────────────────────

import type { PipelineContext, OrchestratorResult } from '../contracts/orchestration.contract';
import type { ClarificationContext }                from '../agents/intent.agent';

import { triageIntent }     from '../agents/triage.agent';
import { decide }           from '../agents/policy.agent';
import { executeAction }    from '../agents/action.agent';
import { generateResponse } from '../agents/response.agent';

export async function runConversationManager(
  ctx: PipelineContext,
  clarificationContext?: ClarificationContext | null
): Promise<OrchestratorResult> {
  const { intent_result, conversation } = ctx;

  if (!intent_result) {
    throw { status: 500, message: 'ConversationManager: intent_result missing from pipeline context.' };
  }

  // ── Step 1: Triage ────────────────────────────────────────────────────────
  let triageResult = ctx.triage_result;
  if (intent_result.intent_group === 'operational') {
    triageResult = triageIntent(intent_result);
    ctx.triage_result = triageResult;
  }

  // ── Step 2: Policy ────────────────────────────────────────────────────────
  const policyOutput = decide(intent_result, triageResult);
  ctx.policy_decision = policyOutput.decision;

  // ── Step 3: Action ────────────────────────────────────────────────────────
  const actionResult = await executeAction({
    context:        conversation,
    intentResult:   intent_result,
    triageResult,
    policyDecision: policyOutput.decision,
    plan:           policyOutput.plan,
  });
  ctx.action_result = actionResult;

  // ── Step 4: Response ──────────────────────────────────────────────────────
  const assistantText = generateResponse({
    actionResult,
    intentResult:      intent_result,
    triageResult,
    policyOutput,
    clarificationContext, // Slice 2: thread through for turn-count-aware wording
  });
  ctx.assistant_text = assistantText;

  // ── Step 5: Build result ──────────────────────────────────────────────────
  const result: OrchestratorResult = {
    assistant_text: assistantText,
    response_mode:  actionResult.response_mode,
    session_id:     conversation.session_id,
    message_id:     '',
    case_id:        actionResult.case_id   ?? null,
    ticket_id:      actionResult.ticket_id ?? null,
  };

  if (process.env.NODE_ENV !== 'production') {
    result.debug = {
      intent_result:   intent_result,
      triage_result:   triageResult,
      policy_decision: policyOutput.decision,
      action_result:   actionResult,
    };
  }

  return result;
}