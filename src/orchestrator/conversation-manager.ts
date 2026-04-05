// ─────────────────────────────────────────────────────────────────────────────
// Conversation Manager — Phase 2, Slice 1
// Orchestrates the five-agent pipeline for operational and clarification flows.
// Called by the Entry Route after the Intent Agent has run.
//
// Pipeline: Intent → Triage (if operational) → Policy → Action → Response
// ─────────────────────────────────────────────────────────────────────────────

import type { PipelineContext }  from '../contracts/orchestration.contract';
import type { OrchestratorResult } from '../contracts/orchestration.contract';

import { triageIntent }   from '../agents/triage.agent';
import { decide }         from '../agents/policy.agent';
import { executeAction }  from '../agents/action.agent';
import { generateResponse } from '../agents/response.agent';

export async function runConversationManager(
  ctx: PipelineContext
): Promise<OrchestratorResult> {
  const { intent_result, conversation } = ctx;

  if (!intent_result) {
    throw { status: 500, message: 'ConversationManager: intent_result missing from pipeline context.' };
  }

  const evidence: string[] = [...intent_result.evidence];

  // ── Step 1: Triage (operational branch only) ──────────────────────────────
  let triageResult = ctx.triage_result;

  if (intent_result.intent_group === 'operational') {
    triageResult = triageIntent(intent_result);
    ctx.triage_result = triageResult;
    evidence.push(...triageResult.evidence);
  }

  // ── Step 2: Policy ────────────────────────────────────────────────────────
  const policyOutput = decide(intent_result, triageResult);
  ctx.policy_decision = policyOutput.decision;
  evidence.push(...policyOutput.evidence);

  // ── Step 3: Action ────────────────────────────────────────────────────────
  const actionResult = await executeAction({
    context:        conversation,
    intentResult:   intent_result,
    triageResult,
    policyDecision: policyOutput.decision,
    plan:           policyOutput.plan,
  });
  ctx.action_result = actionResult;
  evidence.push(...actionResult.execution_summary);

  // ── Step 4: Response ──────────────────────────────────────────────────────
  const assistantText = generateResponse({
    actionResult,
    intentResult: intent_result,
    triageResult,
    policyOutput,
  });
  ctx.assistant_text = assistantText;

  // ── Step 5: Build OrchestratorResult ─────────────────────────────────────
  const result: OrchestratorResult = {
    assistant_text: assistantText,
    response_mode:  actionResult.response_mode,
    session_id:     conversation.session_id,
    message_id:     '',           // Filled in by the route after persistence
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