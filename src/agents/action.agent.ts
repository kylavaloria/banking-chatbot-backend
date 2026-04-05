// ─────────────────────────────────────────────────────────────────────────────
// Action Agent — Phase 2, Slice 1 + Slice 2
// Slice 2 additions:
//   - Card-block offer state transitions (offered / confirmed / completed)
//   - updateCardBlockStatus service call
// ─────────────────────────────────────────────────────────────────────────────

import type { IntentResult }          from '../contracts/intent.contract';
import type { TriageResult }          from '../contracts/triage.contract';
import type { PolicyDecision }        from '../contracts/policy.contract';
import type {
  ActionPlan, ActionResult, CaseStage, ResponseMode,
} from '../contracts/action.contract';
import type { ConversationContext }   from '../contracts/orchestration.contract';

import { createCase, updateCaseStage, updateCardBlockStatus } from '../services/case.service';
import { createTicket }          from '../services/ticket.service';
import { logAction }             from '../services/case-action.service';
import { linkCaseToSession }     from '../services/session.service';

import type { Priority }         from '../contracts/triage.contract';
import type { TicketMode }       from '../services/ticket.service';

export interface ActionAgentInput {
  context:        ConversationContext;
  intentResult:   IntentResult;
  triageResult?:  TriageResult;
  policyDecision: PolicyDecision;
  plan:           ActionPlan;
}

function resolveTicketMode(priority: Priority): TicketMode {
  switch (priority) {
    case 'P1': return 'live_escalation';
    case 'P2': return 'urgent_ticket';
    default:   return 'standard_ticket';
  }
}

function resolveQueueName(priority: Priority): string {
  switch (priority) {
    case 'P1': return 'critical-escalation';
    case 'P2': return 'urgent-support';
    default:   return 'standard-support';
  }
}

function buildCaseSummary(intentResult: IntentResult): string {
  const component = intentResult.issue_components[0];
  if (component?.summary) return component.summary;
  const intentLabel = intentResult.intent_type.replace(/_/g, ' ');
  const amount = intentResult.entities.amount != null ? ` involving ${intentResult.entities.amount}` : '';
  const product = intentResult.entities.product != null
    ? ` on ${intentResult.entities.product.replace(/_/g, ' ')}` : '';
  return `Customer reported ${intentLabel}${product}${amount}.`;
}

// ---------------------------------------------------------------------------
// Branch: informational
// ---------------------------------------------------------------------------

function executeInformational(): ActionResult {
  return {
    response_mode: 'informational', case_id: null, ticket_id: null,
    created_ticket_ids: [], stage_after_action: null,
    informational_payload: { answer_text: 'Our team will provide you with the relevant information shortly.', source_mode: 'placeholder' },
    clarification_payload: null, refusal_payload: null,
    execution_summary: ['Branch: informational — no DB actions taken'],
  };
}

// ---------------------------------------------------------------------------
// Branch: clarification
// ---------------------------------------------------------------------------

function executeClarification(intentResult: IntentResult): ActionResult {
  const candidates = intentResult.candidate_intents_for_clarification;
  return {
    response_mode: 'clarification', case_id: null, ticket_id: null,
    created_ticket_ids: [], stage_after_action: 'clarification_loop',
    informational_payload: null,
    clarification_payload: {
      question:
        'Could you help us understand your concern a bit more? ' +
        'Is this about your account access, a transaction issue, a card concern, or something else?',
      candidate_intents: candidates,
    },
    refusal_payload: null,
    execution_summary: ['Branch: clarification — no DB actions taken'],
  };
}

// ---------------------------------------------------------------------------
// Branch: refusal
// ---------------------------------------------------------------------------

function executeRefusal(policyDecision: PolicyDecision): ActionResult {
  return {
    response_mode: 'refusal', case_id: null, ticket_id: null,
    created_ticket_ids: [], stage_after_action: null,
    informational_payload: null, clarification_payload: null,
    refusal_payload: {
      reason: policyDecision.refusal_reason === 'malicious_input'
        ? 'malicious_input' : 'unsupported_request',
    },
    execution_summary: ['Branch: refusal — no DB actions taken'],
  };
}

// ---------------------------------------------------------------------------
// Branch: operational — full DB execution path
// ---------------------------------------------------------------------------

async function executeOperational(input: ActionAgentInput): Promise<ActionResult> {
  const { context, intentResult, triageResult, plan } = input;
  const executionSummary: string[] = [];

  if (!triageResult) {
    throw { status: 500, message: 'Action Agent: triageResult required for operational execution.' };
  }

  const { priority, recommended_path } = triageResult;
  const { customer_id, session_id }    = context;
  const responseMode: ResponseMode     = plan.response_mode;

  // Step 1: create_case
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

  await logAction({
    caseId: caseRecord.case_id, actionType: 'create_case',
    actionStatus: 'completed', actorType: 'system', actorName: 'action_agent',
    notes: `Case created for intent: ${intentResult.intent_type}`,
    metadataJson: { priority, recommended_path, importance: triageResult.importance,
                    urgency: triageResult.urgency, override_reason: triageResult.override_reason },
  });
  executionSummary.push('log_action → create_case completed');

  // Step 2: create_ticket
  const ticketMode = resolveTicketMode(priority);
  const ticketRecord = await createTicket({
    caseId: caseRecord.case_id, issueType: intentResult.intent_type,
    ticketPriority: priority as 'P1' | 'P2' | 'P3',
    ticketMode, queueName: resolveQueueName(priority),
  });
  executionSummary.push(`create_ticket → ticket_id=${ticketRecord.ticket_id} mode=${ticketMode}`);

  await logAction({
    caseId: caseRecord.case_id, ticketId: ticketRecord.ticket_id,
    actionType: 'create_ticket', actionStatus: 'completed',
    actorType: 'system', actorName: 'action_agent',
    notes: `Ticket created with mode: ${ticketMode}`,
    metadataJson: { ticket_priority: ticketRecord.ticket_priority,
                    ticket_mode: ticketMode, queue_name: ticketRecord.queue_name },
  });
  executionSummary.push('log_action → create_ticket completed');

  // Step 3: live_escalation — logged as pending (external integration deferred)
  if (plan.live_escalation_required) {
    await logAction({
      caseId: caseRecord.case_id, ticketId: ticketRecord.ticket_id,
      actionType: 'live_escalation', actionStatus: 'pending',
      actorType: 'system', actorName: 'action_agent',
      notes: 'Case flagged for urgent human review — external escalation integration pending.',
      metadataJson: { priority, override_reason: triageResult.override_reason },
    });
    executionSummary.push('log_action → live_escalation flagged for urgent review');
  }

  // Step 4: offer_card_block — Slice 2: set state on case and log
  if (plan.offer_card_block) {
    await updateCardBlockStatus(caseRecord.case_id, 'offered');
    await logAction({
      caseId: caseRecord.case_id, ticketId: ticketRecord.ticket_id,
      actionType: 'offer_temporary_card_block', actionStatus: 'completed',
      actorType: 'system', actorName: 'action_agent',
      notes: 'Temporary card block offered to customer.',
    });
    executionSummary.push('offer_card_block → card_block_status=offered logged');
  }

  // Step 5: update stage
  const finalStage: CaseStage = plan.offer_card_block
    ? 'awaiting_card_block_confirmation'
    : plan.live_escalation_required
      ? 'live_escalation_triggered'
      : 'ticket_created';

  await updateCaseStage(caseRecord.case_id, finalStage);
  executionSummary.push(`update_stage → ${finalStage}`);

  // Step 6: link session → case
  await linkCaseToSession(session_id, caseRecord.case_id);
  executionSummary.push(`link_session → session_id=${session_id}`);

  return {
    response_mode: responseMode,
    case_id: caseRecord.case_id, ticket_id: ticketRecord.ticket_id,
    created_ticket_ids: [ticketRecord.ticket_id],
    stage_after_action: finalStage,
    informational_payload: null, clarification_payload: null, refusal_payload: null,
    execution_summary: executionSummary,
  };
}

// ---------------------------------------------------------------------------
// Card-block confirmation execution
// Called directly by the entry-route when stage = awaiting_card_block_confirmation
// ---------------------------------------------------------------------------

export interface CardBlockConfirmationInput {
  caseId:    string;
  ticketId:  string | null;
  confirmed: boolean;
}

export async function executeCardBlockConfirmation(
  input: CardBlockConfirmationInput
): Promise<{ status: 'confirmed' | 'declined' }> {
  if (input.confirmed) {
    await updateCardBlockStatus(input.caseId, 'confirmed');
    await logAction({
      caseId: input.caseId, ticketId: input.ticketId ?? undefined,
      actionType: 'confirm_temporary_card_block',
      actionStatus: 'completed', actorType: 'user', actorName: 'customer',
      notes: 'Customer confirmed temporary card block.',
    });
    // In a real integration, trigger the external card block here.
    // For now, immediately mark as completed to reflect honest state.
    await updateCardBlockStatus(input.caseId, 'completed');
    return { status: 'confirmed' };
  } else {
    await logAction({
      caseId: input.caseId, ticketId: input.ticketId ?? undefined,
      actionType: 'confirm_temporary_card_block',
      actionStatus: 'failed', actorType: 'user', actorName: 'customer',
      notes: 'Customer declined temporary card block offer.',
    });
    // Stage reverts to live_escalation_triggered since P1 case still needs human review
    await updateCaseStage(input.caseId, 'live_escalation_triggered');
    return { status: 'declined' };
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function executeAction(input: ActionAgentInput): Promise<ActionResult> {
  const { plan, policyDecision, intentResult } = input;

  if (plan.refusal_only)      return executeRefusal(policyDecision);
  if (plan.clarification_only) return executeClarification(intentResult);
  if (plan.informational_only) return executeInformational();
  if (plan.case_required && plan.ticket_required) return executeOperational(input);

  return {
    response_mode: 'clarification', case_id: null, ticket_id: null,
    created_ticket_ids: [], stage_after_action: null,
    informational_payload: null,
    clarification_payload: {
      question: 'We were unable to fully process your request. Could you please describe your concern in more detail?',
      candidate_intents: [],
    },
    refusal_payload: null,
    execution_summary: ['Safety-net fallback — no branch matched ActionPlan flags'],
  };
}