// ─────────────────────────────────────────────────────────────────────────────
// Action Agent — Phase 2, Slice 1
// Executes permitted actions in the prescribed SRS order.
// Reads PolicyDecision + ActionPlan and produces ActionResult.
//
// This agent does NOT decide what is allowed — that is the Policy Agent.
// It only executes what the ActionPlan declares.
//
// Execution order per SRS FR-ACT-07:
//   1. create_case
//   2. create_ticket
//   3. live_escalation      (Phase 2 Slice 2+)
//   4. offer_card_block     (Phase 2 Slice 2+)
//   5. update state
//
// Branches:
//   informational  → no DB actions; return informational_payload
//   clarification  → no DB actions; return clarification_payload
//   refusal        → no DB actions; return refusal_payload
//   operational    → create case → create ticket → update stage → log actions
// ─────────────────────────────────────────────────────────────────────────────

import type { IntentResult } from '../contracts/intent.contract';
import type { TriageResult } from '../contracts/triage.contract';
import type { PolicyDecision } from '../contracts/policy.contract';
import type {
  ActionPlan,
  ActionResult,
  CaseStage,
  ResponseMode,
} from '../contracts/action.contract';
import type { ConversationContext } from '../contracts/orchestration.contract';

import { createCase }           from '../services/case.service';
import { createTicket }         from '../services/ticket.service';
import { logAction }            from '../services/case-action.service';
import { linkCaseToSession }    from '../services/session.service';
import { updateCaseStage }      from '../services/case.service';

import type { Priority }        from '../contracts/triage.contract';
import type { TicketMode }      from '../services/ticket.service';

// ---------------------------------------------------------------------------
// Input type for the Action Agent
// ---------------------------------------------------------------------------

export interface ActionAgentInput {
  context:        ConversationContext;
  intentResult:   IntentResult;
  triageResult?:  TriageResult;
  policyDecision: PolicyDecision;
  plan:           ActionPlan;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Maps triage priority to the DB-safe ticket mode enum value. */
function resolveTicketMode(priority: Priority): TicketMode {
  switch (priority) {
    case 'P1': return 'live_escalation';
    case 'P2': return 'urgent_ticket';
    default:   return 'standard_ticket';
  }
}

/** Maps triage priority to a human-readable queue name. */
function resolveQueueName(priority: Priority): string {
  switch (priority) {
    case 'P1': return 'critical-escalation';
    case 'P2': return 'urgent-support';
    default:   return 'standard-support';
  }
}

/** Builds a one-sentence case summary from intent and entities. */
function buildCaseSummary(intentResult: IntentResult): string {
  const component = intentResult.issue_components[0];
  if (component?.summary) return component.summary;

  const intentLabel = intentResult.intent_type.replace(/_/g, ' ');
  const amount = intentResult.entities.amount != null
    ? ` involving ${intentResult.entities.amount}`
    : '';
  const product = intentResult.entities.product != null
    ? ` on ${intentResult.entities.product.replace(/_/g, ' ')}`
    : '';

  return `Customer reported ${intentLabel}${product}${amount}.`;
}

// ---------------------------------------------------------------------------
// Branch: informational — no DB actions
// ---------------------------------------------------------------------------

function executeInformational(): ActionResult {
  return {
    response_mode:          'informational',
    case_id:                null,
    ticket_id:              null,
    created_ticket_ids:     [],
    stage_after_action:     null,
    informational_payload: {
      answer_text:  'Our team will provide you with the relevant information shortly.',
      source_mode:  'placeholder',
    },
    clarification_payload:  null,
    refusal_payload:        null,
    execution_summary:      ['Branch: informational — no DB actions taken'],
  };
}

// ---------------------------------------------------------------------------
// Branch: clarification — no DB actions
// ---------------------------------------------------------------------------

function executeClarification(intentResult: IntentResult): ActionResult {
  const candidates = intentResult.candidate_intents_for_clarification;
  return {
    response_mode:         'clarification',
    case_id:               null,
    ticket_id:             null,
    created_ticket_ids:    [],
    stage_after_action:    'clarification_loop',
    informational_payload: null,
    clarification_payload: {
      question:
        'Could you help us understand your concern a bit more? ' +
        'Is this about your account access, a transaction issue, a card concern, ' +
        'or something else?',
      candidate_intents: candidates,
    },
    refusal_payload:      null,
    execution_summary:    ['Branch: clarification — no DB actions taken'],
  };
}

// ---------------------------------------------------------------------------
// Branch: refusal — no DB actions
// ---------------------------------------------------------------------------

function executeRefusal(policyDecision: PolicyDecision): ActionResult {
  return {
    response_mode:         'refusal',
    case_id:               null,
    ticket_id:             null,
    created_ticket_ids:    [],
    stage_after_action:    null,
    informational_payload: null,
    clarification_payload: null,
    refusal_payload: {
      reason: policyDecision.refusal_reason === 'malicious_input'
        ? 'malicious_input'
        : 'unsupported_request',
    },
    execution_summary: ['Branch: refusal — no DB actions taken'],
  };
}

// ---------------------------------------------------------------------------
// Branch: operational — full DB execution path
// SRS FR-ACT-04 (P2/P3) and FR-ACT-05 (P1)
// ---------------------------------------------------------------------------

async function executeOperational(
  input: ActionAgentInput
): Promise<ActionResult> {
  const { context, intentResult, triageResult, plan } = input;
  const executionSummary: string[] = [];

  if (!triageResult) {
    throw {
      status: 500,
      message: 'Action Agent: triageResult is required for operational execution.',
    };
  }

  const { priority, recommended_path } = triageResult;
  const { customer_id, session_id }    = context;
  const responseMode: ResponseMode     = plan.response_mode;

  // ── Step 1: create_case ───────────────────────────────────────────────────
  const caseRecord = await createCase({
    customerId:       customer_id,
    sessionId:        session_id,
    primaryIntentType:intentResult.intent_type,
    summary:          buildCaseSummary(intentResult),
    importance:       triageResult.importance,
    urgency:          triageResult.urgency,
    priority:         priority as 'P1' | 'P2' | 'P3',
    recommendedPath:  recommended_path === 'self_service'
                        ? 'standard_ticket'
                        : recommended_path as 'standard_ticket' | 'urgent_ticket' | 'live_escalation',
  });
  executionSummary.push(`create_case → case_id=${caseRecord.case_id}`);

  // ── Log create_case action ────────────────────────────────────────────────
  await logAction({
    caseId:      caseRecord.case_id,
    actionType:  'create_case',
    actionStatus:'completed',
    actorType:   'system',
    actorName:   'action_agent',
    notes:       `Case created for intent: ${intentResult.intent_type}`,
    metadataJson:{
      priority,
      recommended_path,
      importance:  triageResult.importance,
      urgency:     triageResult.urgency,
      override_reason: triageResult.override_reason,
    },
  });
  executionSummary.push('log_action → create_case completed');

  // ── Step 2: create_ticket ─────────────────────────────────────────────────
  const ticketMode = resolveTicketMode(priority);
  const ticketRecord = await createTicket({
    caseId:         caseRecord.case_id,
    issueType:      intentResult.intent_type,
    ticketPriority: priority as 'P1' | 'P2' | 'P3',
    ticketMode,
    queueName:      resolveQueueName(priority),
  });
  executionSummary.push(
    `create_ticket → ticket_id=${ticketRecord.ticket_id} mode=${ticketMode}`
  );

  // ── Log create_ticket action ──────────────────────────────────────────────
  await logAction({
    caseId:      caseRecord.case_id,
    ticketId:    ticketRecord.ticket_id,
    actionType:  'create_ticket',
    actionStatus:'completed',
    actorType:   'system',
    actorName:   'action_agent',
    notes:       `Ticket created with mode: ${ticketMode}`,
    metadataJson:{
      ticket_priority: ticketRecord.ticket_priority,
      ticket_mode:     ticketMode,
      queue_name:      ticketRecord.queue_name,
    },
  });
  executionSummary.push('log_action → create_ticket completed');

  // ── Step 3: live_escalation ───────────────────────────────────────────────
  // Placeholder for Phase 2 Slice 2. Logged but not externally triggered yet.
  if (plan.live_escalation_required) {
    await logAction({
      caseId:      caseRecord.case_id,
      ticketId:    ticketRecord.ticket_id,
      actionType:  'live_escalation',
      actionStatus:'pending',
      actorType:   'system',
      actorName:   'action_agent',
      notes:       'Live escalation queued — external trigger not yet implemented.',
      metadataJson:{ priority, override_reason: triageResult.override_reason },
    });
    executionSummary.push('log_action → live_escalation queued (pending external integration)');
  }

  // ── Step 4: offer_card_block ──────────────────────────────────────────────
  // Placeholder for Phase 2 Slice 2. Logged but not offered to user yet.
  if (plan.offer_card_block) {
    await logAction({
      caseId:      caseRecord.case_id,
      ticketId:    ticketRecord.ticket_id,
      actionType:  'offer_temporary_card_block',
      actionStatus:'pending',
      actorType:   'system',
      actorName:   'action_agent',
      notes:       'Card block offer deferred — awaiting Slice 2 confirmation flow.',
    });
    executionSummary.push('log_action → offer_card_block deferred to Slice 2');
  }

  // ── Step 5: update case stage ─────────────────────────────────────────────
  const finalStage: CaseStage = plan.live_escalation_required
    ? 'live_escalation_triggered'
    : 'ticket_created';

  await updateCaseStage(caseRecord.case_id, finalStage);
  executionSummary.push(`update_stage → ${finalStage}`);

  // ── Step 6: link session → case ───────────────────────────────────────────
  await linkCaseToSession(session_id, caseRecord.case_id);
  executionSummary.push(`link_session → session_id=${session_id} case_id=${caseRecord.case_id}`);

  return {
    response_mode:         responseMode,
    case_id:               caseRecord.case_id,
    ticket_id:             ticketRecord.ticket_id,
    created_ticket_ids:    [ticketRecord.ticket_id],
    stage_after_action:    finalStage,
    informational_payload: null,
    clarification_payload: null,
    refusal_payload:       null,
    execution_summary:     executionSummary,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Executes the ActionPlan and returns an ActionResult.
 *
 * This is the only function the orchestrator calls.
 * Branch selection is derived from plan flags — not re-evaluated here.
 */
export async function executeAction(input: ActionAgentInput): Promise<ActionResult> {
  const { plan, policyDecision, intentResult } = input;

  if (plan.refusal_only) {
    return executeRefusal(policyDecision);
  }

  if (plan.clarification_only) {
    return executeClarification(intentResult);
  }

  if (plan.informational_only) {
    return executeInformational();
  }

  if (plan.case_required && plan.ticket_required) {
    return executeOperational(input);
  }

  // Safety-net: unrecognised plan state — treat as clarification
  return {
    response_mode:         'clarification',
    case_id:               null,
    ticket_id:             null,
    created_ticket_ids:    [],
    stage_after_action:    null,
    informational_payload: null,
    clarification_payload: {
      question:
        'We were unable to fully process your request. ' +
        'Could you please describe your concern in more detail?',
      candidate_intents: [],
    },
    refusal_payload:   null,
    execution_summary: ['Safety-net fallback — no branch matched ActionPlan flags'],
  };
}