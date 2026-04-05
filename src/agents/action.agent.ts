// ─────────────────────────────────────────────────────────────────────────────
// Action Agent — Slice 1 + Slice 2 + Slice 3
// Slice 3 additions:
//   - executeMultiIssue: one parent case + one ticket per component
//   - topic switch: creates new case even when active case exists
// ─────────────────────────────────────────────────────────────────────────────

import type { IntentResult }         from '../contracts/intent.contract';
import type { TriageResult }         from '../contracts/triage.contract';
import type { PolicyDecision }       from '../contracts/policy.contract';
import type {
  ActionPlan, ActionResult, CaseStage, ResponseMode,
} from '../contracts/action.contract';
import type { ConversationContext }  from '../contracts/orchestration.contract';

import {
  createCase, updateCaseStage, updateCardBlockStatus,
} from '../services/case.service';
import { createTicket }         from '../services/ticket.service';
import { logAction }            from '../services/case-action.service';
import { linkCaseToSession }    from '../services/session.service';
import { triageIntent }         from './triage.agent';

import type { Priority }        from '../contracts/triage.contract';
import type { TicketMode }      from '../services/ticket.service';

export interface ActionAgentInput {
  context:        ConversationContext;
  intentResult:   IntentResult;
  triageResult?:  TriageResult;
  policyDecision: PolicyDecision;
  plan:           ActionPlan;
}

export interface CardBlockConfirmationInput {
  caseId:    string;
  ticketId:  string | null;
  confirmed: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
  const c = intentResult.issue_components[0];
  if (c?.summary) return c.summary;
  const label   = intentResult.intent_type.replace(/_/g, ' ');
  const amount  = intentResult.entities.amount != null ? ` involving ${intentResult.entities.amount}` : '';
  const product = intentResult.entities.product != null
    ? ` on ${intentResult.entities.product.replace(/_/g, ' ')}` : '';
  return `Customer reported ${label}${product}${amount}.`;
}

// ---------------------------------------------------------------------------
// Non-DB branches (unchanged)
// ---------------------------------------------------------------------------

function executeInformational(): ActionResult {
  return {
    response_mode: 'informational', case_id: null, ticket_id: null,
    created_ticket_ids: [], stage_after_action: null,
    informational_payload: { answer_text: 'Our team will provide you with the relevant information shortly.', source_mode: 'placeholder' },
    clarification_payload: null, refusal_payload: null,
    execution_summary: ['Branch: informational — no DB actions'],
  };
}

function executeClarification(intentResult: IntentResult): ActionResult {
  return {
    response_mode: 'clarification', case_id: null, ticket_id: null,
    created_ticket_ids: [], stage_after_action: 'clarification_loop',
    informational_payload: null,
    clarification_payload: {
      question: 'Could you help us understand your concern a bit more? Is this about your account access, a transaction issue, a card concern, or something else?',
      candidate_intents: intentResult.candidate_intents_for_clarification,
    },
    refusal_payload: null,
    execution_summary: ['Branch: clarification — no DB actions'],
  };
}

function executeRefusal(policyDecision: PolicyDecision): ActionResult {
  return {
    response_mode: 'refusal', case_id: null, ticket_id: null,
    created_ticket_ids: [], stage_after_action: null,
    informational_payload: null, clarification_payload: null,
    refusal_payload: {
      reason: policyDecision.refusal_reason === 'malicious_input'
        ? 'malicious_input' : 'unsupported_request',
    },
    execution_summary: ['Branch: refusal — no DB actions'],
  };
}

// ---------------------------------------------------------------------------
// Standard operational branch (Slice 1 / Slice 2)
// Slice 3: respects topic_switch flag — always creates a new case regardless
// of whether an active case exists.
// ---------------------------------------------------------------------------

async function executeOperational(input: ActionAgentInput): Promise<ActionResult> {
  const { context, intentResult, triageResult, plan } = input;
  const summary: string[] = [];

  if (!triageResult) throw { status: 500, message: 'Action Agent: triageResult required.' };

  const { priority, recommended_path } = triageResult;
  const { customer_id, session_id }    = context;
  const responseMode: ResponseMode     = plan.response_mode;

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
  summary.push(`create_case → ${caseRecord.case_id}`);

  await logAction({
    caseId: caseRecord.case_id, actionType: 'create_case', actionStatus: 'completed',
    actorType: 'system', actorName: 'action_agent',
    notes: `Case created for intent: ${intentResult.intent_type}`,
    metadataJson: { priority, recommended_path, importance: triageResult.importance,
                    urgency: triageResult.urgency, override_reason: triageResult.override_reason,
                    topic_switch: intentResult.flags.topic_switch },
  });

  const ticketMode   = resolveTicketMode(priority);
  const ticketRecord = await createTicket({
    caseId: caseRecord.case_id, issueType: intentResult.intent_type,
    ticketPriority: priority as 'P1' | 'P2' | 'P3',
    ticketMode, queueName: resolveQueueName(priority),
  });
  summary.push(`create_ticket → ${ticketRecord.ticket_id} (${ticketMode})`);

  await logAction({
    caseId: caseRecord.case_id, ticketId: ticketRecord.ticket_id,
    actionType: 'create_ticket', actionStatus: 'completed',
    actorType: 'system', actorName: 'action_agent',
    notes: `Ticket created: ${ticketMode}`,
    metadataJson: { ticket_priority: priority, ticket_mode: ticketMode },
  });

  if (plan.live_escalation_required) {
    await logAction({
      caseId: caseRecord.case_id, ticketId: ticketRecord.ticket_id,
      actionType: 'live_escalation', actionStatus: 'pending',
      actorType: 'system', actorName: 'action_agent',
      notes: 'Flagged for urgent human review.',
      metadataJson: { priority, override_reason: triageResult.override_reason },
    });
    summary.push('live_escalation logged (pending)');
  }

  if (plan.offer_card_block) {
    await updateCardBlockStatus(caseRecord.case_id, 'offered');
    await logAction({
      caseId: caseRecord.case_id, ticketId: ticketRecord.ticket_id,
      actionType: 'offer_temporary_card_block', actionStatus: 'completed',
      actorType: 'system', actorName: 'action_agent',
      notes: 'Temporary card block offered.',
    });
    summary.push('card_block offered');
  }

  const finalStage: CaseStage = plan.offer_card_block
    ? 'awaiting_card_block_confirmation'
    : plan.live_escalation_required
      ? 'live_escalation_triggered'
      : 'ticket_created';

  await updateCaseStage(caseRecord.case_id, finalStage);
  await linkCaseToSession(session_id, caseRecord.case_id);
  summary.push(`stage → ${finalStage}, session linked`);

  return {
    response_mode: responseMode,
    case_id: caseRecord.case_id, ticket_id: ticketRecord.ticket_id,
    created_ticket_ids: [ticketRecord.ticket_id],
    stage_after_action: finalStage,
    informational_payload: null, clarification_payload: null, refusal_payload: null,
    execution_summary: summary,
  };
}

// ---------------------------------------------------------------------------
// Slice 3: Multi-issue execution
// One parent case, one ticket per operational issue_component.
// ---------------------------------------------------------------------------

async function executeMultiIssue(input: ActionAgentInput): Promise<ActionResult> {
  const { context, intentResult } = input;
  const { customer_id, session_id } = context;
  const summary: string[] = [];

  const operationalComponents = intentResult.issue_components.filter(
    c => c.intent_group === 'operational'
  );

  if (operationalComponents.length === 0) {
    throw { status: 500, message: 'Action Agent: multi-issue with no operational components.' };
  }

  // Triage each component individually; take the highest priority overall
  const triagedComponents = operationalComponents.map(c => ({
    component: c,
    triage:    triageIntent({ ...intentResult, intent_type: c.intent_type, issue_components: [c] }),
  }));

  const highestPriority = triagedComponents.reduce(
    (best, curr) => {
      const rank = { P1: 0, P2: 1, P3: 2, P4: 3 };
      return rank[curr.triage.priority] < rank[best.triage.priority] ? curr : best;
    }
  );

  // Create parent case using the highest-priority triage result
  const parentTriage = highestPriority.triage;
  const parentCase   = await createCase({
    customerId:       customer_id,
    sessionId:        session_id,
    primaryIntentType:'multi_issue_case',
    summary:          `Multi-issue case: ${operationalComponents.map(c => c.intent_type.replace(/_/g, ' ')).join(' + ')}.`,
    importance:       parentTriage.importance,
    urgency:          parentTriage.urgency,
    priority:         parentTriage.priority as 'P1' | 'P2' | 'P3',
    recommendedPath:  parentTriage.recommended_path === 'self_service'
                        ? 'standard_ticket'
                        : parentTriage.recommended_path as 'standard_ticket' | 'urgent_ticket' | 'live_escalation',
  });
  summary.push(`create_case (parent) → ${parentCase.case_id}`);

  await logAction({
    caseId: parentCase.case_id, actionType: 'create_case', actionStatus: 'completed',
    actorType: 'system', actorName: 'action_agent',
    notes: `Multi-issue parent case created (${operationalComponents.length} components).`,
    metadataJson: { component_count: operationalComponents.length,
                    intents: operationalComponents.map(c => c.intent_type) },
  });

  // Log split action
  await logAction({
    caseId: parentCase.case_id, actionType: 'split_into_multiple_tickets',
    actionStatus: 'completed', actorType: 'system', actorName: 'action_agent',
    notes: `Splitting into ${operationalComponents.length} tickets.`,
    metadataJson: { intents: operationalComponents.map(c => c.intent_type) },
  });
  summary.push('split_into_multiple_tickets logged');

  // Create one ticket per component
  const ticketIds: string[] = [];
  for (const { component, triage } of triagedComponents) {
    const ticketMode = resolveTicketMode(triage.priority);
    const ticket     = await createTicket({
      caseId:         parentCase.case_id,
      issueType:      component.intent_type,
      ticketPriority: triage.priority as 'P1' | 'P2' | 'P3',
      ticketMode,
      queueName:      resolveQueueName(triage.priority),
    });
    ticketIds.push(ticket.ticket_id);
    summary.push(`create_ticket (${component.intent_type}) → ${ticket.ticket_id} [${triage.priority}]`);

    await logAction({
      caseId: parentCase.case_id, ticketId: ticket.ticket_id,
      actionType: 'create_ticket', actionStatus: 'completed',
      actorType: 'system', actorName: 'action_agent',
      notes: `Ticket for: ${component.intent_type}`,
      metadataJson: { issue_type: component.intent_type, priority: triage.priority, ticket_mode: ticketMode },
    });
  }

  await updateCaseStage(parentCase.case_id, 'split_ticket_created');
  await linkCaseToSession(session_id, parentCase.case_id);
  summary.push(`stage → split_ticket_created, session linked`);

  return {
    response_mode:       'multi_issue_confirmation',
    case_id:             parentCase.case_id,
    ticket_id:           ticketIds[0] ?? null,
    created_ticket_ids:  ticketIds,
    stage_after_action:  'split_ticket_created',
    informational_payload: null, clarification_payload: null, refusal_payload: null,
    execution_summary: summary,
  };
}

// ---------------------------------------------------------------------------
// Card-block confirmation (Slice 2, unchanged)
// ---------------------------------------------------------------------------

export async function executeCardBlockConfirmation(
  input: CardBlockConfirmationInput
): Promise<{ status: 'confirmed' | 'declined' }> {
  if (input.confirmed) {
    await updateCardBlockStatus(input.caseId, 'confirmed');
    await logAction({
      caseId: input.caseId, ticketId: input.ticketId ?? undefined,
      actionType: 'confirm_temporary_card_block', actionStatus: 'completed',
      actorType: 'user', actorName: 'customer',
      notes: 'Customer confirmed temporary card block.',
    });
    await updateCardBlockStatus(input.caseId, 'completed');
    return { status: 'confirmed' };
  } else {
    await logAction({
      caseId: input.caseId, ticketId: input.ticketId ?? undefined,
      actionType: 'confirm_temporary_card_block', actionStatus: 'failed',
      actorType: 'user', actorName: 'customer',
      notes: 'Customer declined temporary card block.',
    });
    await updateCaseStage(input.caseId, 'live_escalation_triggered');
    return { status: 'declined' };
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function executeAction(input: ActionAgentInput): Promise<ActionResult> {
  const { plan, policyDecision, intentResult } = input;

  if (plan.refusal_only)                           return executeRefusal(policyDecision);
  if (plan.clarification_only)                     return executeClarification(intentResult);
  if (plan.informational_only)                     return executeInformational();
  if (plan.split_required)                         return executeMultiIssue(input);
  if (plan.case_required && plan.ticket_required)  return executeOperational(input);

  return {
    response_mode: 'clarification', case_id: null, ticket_id: null,
    created_ticket_ids: [], stage_after_action: null,
    informational_payload: null,
    clarification_payload: {
      question: 'We were unable to fully process your request. Could you please describe your concern in more detail?',
      candidate_intents: [],
    },
    refusal_payload: null,
    execution_summary: ['Safety-net fallback'],
  };
}