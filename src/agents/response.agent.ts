// ─────────────────────────────────────────────────────────────────────────────
// Response Agent — Slice 1 + Slice 2 + Slice 3
// Slice 3 additions:
//   - renderMultiIssueConfirmation
//   - renderHybridResponse (informational + operational combined)
//   - topic-switch wording in renderTicketConfirmation / renderCritical
// ─────────────────────────────────────────────────────────────────────────────

import type { ActionResult }          from '../contracts/action.contract';
import type { IntentResult }          from '../contracts/intent.contract';
import type { TriageResult }          from '../contracts/triage.contract';
import type { ResponseInput }         from '../contracts/response.contract';
import type { PolicyOutput }          from './policy.agent';
import type { ClarificationContext }  from './intent.agent';

export interface ResponseAgentInput {
  actionResult:          ActionResult;
  intentResult:          IntentResult;
  triageResult?:         TriageResult;
  policyOutput:          PolicyOutput;
  clarificationContext?: ClarificationContext | null;
  cardBlockOutcome?:     'confirmed' | 'declined' | null;
  /** Slice 3: pre-fetched informational answer for the hybrid informational branch */
  hybridInformationalAnswer?: string | null;
  /** Slice 3: true when a topic switch caused a new case to be opened */
  topicSwitched?: boolean;
}

// ---------------------------------------------------------------------------
// Step 1: Build ResponseInput
// ---------------------------------------------------------------------------

function buildActionsTakenList(actionResult: ActionResult, topicSwitched?: boolean): string[] {
  switch (actionResult.response_mode) {
    case 'ticket_confirmation':
      return [
        topicSwitched ? 'A new support case has been opened for your new concern.' : 'A support case has been opened for your concern.',
        'A support ticket has been created and assigned to our team.',
      ];
    case 'critical_action_confirmation':
      return [
        'A support case has been opened and marked as high priority.',
        'A support ticket has been assigned to our urgent review queue.',
        'Your case has been flagged for priority human review.',
      ];
    case 'multi_issue_confirmation': {
      const count = actionResult.created_ticket_ids?.length ?? 0;
      return [
        `A support case has been opened for your concerns.`,
        `${count} separate support ticket${count !== 1 ? 's have' : ' has'} been created — one for each concern.`,
        'Each concern will be handled by the appropriate team.',
      ];
    }
    default:
      return [];
  }
}

function buildNextStep(
  mode: ActionResult['response_mode'],
  triageResult?: TriageResult,
  clarificationContext?: ClarificationContext | null,
  topicSwitched?: boolean
): string {
  switch (mode) {
    case 'ticket_confirmation':
      if (topicSwitched) return 'Your new concern is being handled separately. Our team will follow up on both cases.';
      return triageResult?.priority === 'P2'
        ? 'Our team will review your case on a priority basis and follow up shortly.'
        : 'Our team will review your ticket and get back to you within our standard service window.';
    case 'critical_action_confirmation':
      return 'Our team will attend to your case as a matter of urgency. You will be contacted as soon as possible.';
    case 'multi_issue_confirmation':
      return 'Each ticket is being tracked separately. Our team will follow up on each concern.';
    case 'informational':
      return 'Let us know if you have any other questions — we are here to help.';
    case 'clarification': {
      const turn = clarificationContext?.turnCount ?? 0;
      return turn >= 2
        ? 'Please take your time — any detail will help us assist you correctly.'
        : 'Your response will help us direct your concern to the right team right away.';
    }
    case 'refusal':
      return 'If you have a banking or account-related concern, please describe it and we will be glad to assist.';
    default:
      return 'Please let us know if there is anything else we can help you with.';
  }
}

function buildResponseInput(input: ResponseAgentInput): ResponseInput {
  const { actionResult, intentResult, triageResult, policyOutput, clarificationContext, topicSwitched } = input;
  const mode          = actionResult.response_mode;
  const intentLabel   = intentResult.intent_type.replace(/_/g, ' ');
  const intentSummary = intentResult.issue_components[0]?.summary ?? `Your concern regarding ${intentLabel}`;

  return {
    response_mode:             mode,
    intent_summary:            intentSummary,
    actions_taken:             buildActionsTakenList(actionResult, topicSwitched),
    next_step:                 buildNextStep(mode, triageResult, clarificationContext, topicSwitched),
    tone_profile:              policyOutput.tone,
    card_block_offered:        actionResult.stage_after_action === 'awaiting_card_block_confirmation',
    live_escalation_triggered: actionResult.stage_after_action === 'live_escalation_triggered',
    informational_answer:      actionResult.informational_payload?.answer_text ?? null,
    clarification_question:    actionResult.clarification_payload?.question ?? null,
    refusal_reason:            actionResult.refusal_payload?.reason ?? null,
  };
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

function renderInformational(input: ResponseInput): string {
  const answer = input.informational_answer ?? 'We have noted your inquiry and will provide the relevant information.';
  return [`Thank you for reaching out.`, ``, answer, ``, input.next_step].join('\n');
}

function renderClarification(input: ResponseInput): string {
  const question = input.clarification_question ?? 'Could you please provide more details about your concern?';
  return [
    `Thank you for getting in touch.`, ``,
    `To make sure we assist you in the best way possible, we have a quick question:`, ``,
    question, ``, input.next_step,
  ].join('\n');
}

function renderTicketConfirmation(input: ResponseInput, topicSwitched?: boolean): string {
  const actionLines = input.actions_taken.map((a: string) => `• ${a}`).join('\n');
  const topicNote   = topicSwitched
    ? `\n\nWe noticed this is a different concern from your previous case. We have opened a new case for this issue.`
    : '';
  return [
    `Thank you for bringing this to our attention. We have received your concern regarding:`, ``,
    `"${input.intent_summary}"`,
    topicNote, ``,
    `Here is what we have done:`, actionLines, ``, input.next_step,
  ].join('\n');
}

function renderCriticalActionConfirmation(input: ResponseInput, topicSwitched?: boolean): string {
  const actionLines = input.actions_taken.map((a: string) => `• ${a}`).join('\n');
  const topicNote   = topicSwitched
    ? `\n\nThis is being treated as a new case separate from any previous concern.`
    : '';
  const cardBlockSection = input.card_block_offered
    ? `\n\nFor your protection, we would also like to place a temporary block on your card while we investigate. Please reply with YES to confirm the block, or NO to keep your card active.`
    : '';
  return [
    `We have received your report and your case has been given the highest priority.`, ``,
    `Regarding your concern:`,
    `"${input.intent_summary}"`,
    topicNote, ``,
    `Here is what we have done:`, actionLines,
    cardBlockSection, ``, input.next_step,
  ].join('\n');
}

function renderMultiIssueConfirmation(
  input: ResponseInput,
  actionResult: ActionResult
): string {
  const actionLines  = input.actions_taken.map((a: string) => `• ${a}`).join('\n');
  const ticketCount  = actionResult.created_ticket_ids?.length ?? 0;
  return [
    `Thank you for reaching out. We have received your message and identified ${ticketCount} separate concern${ticketCount !== 1 ? 's' : ''}.`, ``,
    `Here is what we have done:`, actionLines, ``,
    `Each concern is being tracked independently so our team can address them separately.`, ``,
    input.next_step,
  ].join('\n');
}

function renderHybridResponse(
  input: ResponseInput,
  hybridAnswer: string,
  actionResult: ActionResult
): string {
  const actionLines = input.actions_taken.map((a: string) => `• ${a}`).join('\n');
  return [
    `Thank you for your message. We have noted two parts to your inquiry:`, ``,
    `**Regarding your question:**`,
    hybridAnswer, ``,
    `**Regarding your concern:**`,
    `"${input.intent_summary}"`, ``,
    `Here is what we have done:`, actionLines, ``,
    input.next_step,
  ].join('\n');
}

function renderCardBlockConfirmed(): string {
  return [
    `Understood. Your card block has been confirmed.`, ``,
    `Your card has been temporarily blocked to prevent any further unauthorised use. `,
    `Our team is actively reviewing your case and will follow up with you shortly.`, ``,
    `If you need to use your card before our team contacts you, please call our support line directly.`,
  ].join('\n');
}

function renderCardBlockDeclined(): string {
  return [
    `Understood — your card will remain active.`, ``,
    `Your case has been escalated to our team for urgent review. `,
    `We will follow up with you as soon as possible.`, ``,
    `If you change your mind about blocking your card or notice any further suspicious activity, `,
    `please contact us immediately.`,
  ].join('\n');
}

function renderRefusal(input: ResponseInput): string {
  return [
    `Thank you for reaching out.`, ``,
    `We are a dedicated BFSI customer support service and are only able to assist with ` +
    `banking, financial services, and insurance-related concerns — such as account issues, ` +
    `transactions, cards, loans, and related inquiries.`, ``,
    `We are unable to assist with the request you have described.`, ``,
    input.next_step,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

function buildMessage(
  input: ResponseInput,
  extra: {
    cardBlockOutcome?:         'confirmed' | 'declined' | null;
    hybridInformationalAnswer?: string | null;
    topicSwitched?:            boolean;
    actionResult:              ActionResult;
  }
): string {
  if (extra.cardBlockOutcome === 'confirmed') return renderCardBlockConfirmed();
  if (extra.cardBlockOutcome === 'declined')  return renderCardBlockDeclined();

  if (extra.hybridInformationalAnswer && input.response_mode !== 'informational') {
    return renderHybridResponse(input, extra.hybridInformationalAnswer, extra.actionResult);
  }

  switch (input.response_mode) {
    case 'informational':               return renderInformational(input);
    case 'clarification':               return renderClarification(input);
    case 'ticket_confirmation':         return renderTicketConfirmation(input, extra.topicSwitched);
    case 'critical_action_confirmation':return renderCriticalActionConfirmation(input, extra.topicSwitched);
    case 'multi_issue_confirmation':    return renderMultiIssueConfirmation(input, extra.actionResult);
    case 'refusal':                     return renderRefusal(input);
    default:                            return renderClarification(input);
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function generateResponse(input: ResponseAgentInput): string {
  const responseInput = buildResponseInput(input);
  return buildMessage(responseInput, {
    cardBlockOutcome:          input.cardBlockOutcome,
    hybridInformationalAnswer: input.hybridInformationalAnswer ?? null,
    topicSwitched:             input.topicSwitched ?? false,
    actionResult:              input.actionResult,
  });
}