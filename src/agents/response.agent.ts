// ─────────────────────────────────────────────────────────────────────────────
// Response Agent — Phase 2, Slice 1 + Slice 2
// Slice 2 changes:
//   - P1 wording is honest: "prioritized for urgent review" not "agent connecting"
//   - Card-block offer template
//   - Card-block confirmed / declined templates
//   - Clarification turn count awareness
// ─────────────────────────────────────────────────────────────────────────────

import type { ActionResult }   from '../contracts/action.contract';
import type { IntentResult }   from '../contracts/intent.contract';
import type { TriageResult }   from '../contracts/triage.contract';
import type { ResponseInput }  from '../contracts/response.contract';
import type { PolicyOutput }   from './policy.agent';
import type { ClarificationContext } from './intent.agent';

export interface ResponseAgentInput {
  actionResult:          ActionResult;
  intentResult:          IntentResult;
  triageResult?:         TriageResult;
  policyOutput:          PolicyOutput;
  clarificationContext?: ClarificationContext | null;
  /** Populated by entry-route for card-block confirmation responses */
  cardBlockOutcome?:     'confirmed' | 'declined' | null;
}

// ---------------------------------------------------------------------------
// Step 1: Build ResponseInput
// ---------------------------------------------------------------------------

function buildResponseInput(input: ResponseAgentInput): ResponseInput {
  const { actionResult, intentResult, triageResult, policyOutput, clarificationContext } = input;
  const mode = actionResult.response_mode;

  const intentLabel = intentResult.intent_type.replace(/_/g, ' ');
  const intentSummary = intentResult.issue_components[0]?.summary
    ?? `Your concern regarding ${intentLabel}`;

  const actionsTaken = buildActionsTakenList(actionResult);
  const nextStep = buildNextStep(mode, triageResult, clarificationContext);

  return {
    response_mode:             mode,
    intent_summary:            intentSummary,
    actions_taken:             actionsTaken,
    next_step:                 nextStep,
    tone_profile:              policyOutput.tone,
    card_block_offered:        actionResult.stage_after_action === 'awaiting_card_block_confirmation',
    live_escalation_triggered: actionResult.stage_after_action === 'live_escalation_triggered',
    informational_answer:      actionResult.informational_payload?.answer_text ?? null,
    clarification_question:    actionResult.clarification_payload?.question ?? null,
    refusal_reason:            actionResult.refusal_payload?.reason ?? null,
  };
}

function buildActionsTakenList(actionResult: ActionResult): string[] {
  switch (actionResult.response_mode) {
    case 'ticket_confirmation':
      return [
        'A support case has been opened for your concern.',
        'A support ticket has been created and assigned to our team.',
      ];
    case 'critical_action_confirmation':
      return [
        'A support case has been opened and marked as high priority.',
        'A support ticket has been assigned to our urgent review queue.',
        'Your case has been flagged for priority human review.',
      ];
    default:
      return [];
  }
}

function buildNextStep(
  mode: ActionResult['response_mode'],
  triageResult?: TriageResult,
  clarificationContext?: ClarificationContext | null
): string {
  switch (mode) {
    case 'ticket_confirmation':
      return triageResult?.priority === 'P2'
        ? 'Our team will review your case on a priority basis and follow up with you shortly.'
        : 'Our team will review your ticket and get back to you within our standard service window.';
    case 'critical_action_confirmation':
      // Honest: no real-time handoff yet
      return 'Our team will attend to your case as a matter of urgency. You will be contacted as soon as possible.';
    case 'informational':
      return 'Let us know if you have any other questions — we are here to help.';
    case 'clarification': {
      const turn = clarificationContext?.turnCount ?? 0;
      return turn >= 2
        ? 'Please take your time — any detail you can share will help us assist you correctly.'
        : 'Your response will help us direct your concern to the right team right away.';
    }
    case 'refusal':
      return 'If you have a banking or account-related concern, please describe it and we will be glad to assist.';
    default:
      return 'Please let us know if there is anything else we can help you with.';
  }
}

// ---------------------------------------------------------------------------
// Step 2: Template rendering
// ---------------------------------------------------------------------------

function renderInformational(input: ResponseInput): string {
  const answer = input.informational_answer
    ?? 'We have noted your inquiry and will provide the relevant information.';
  return [`Thank you for reaching out.`, ``, answer, ``, input.next_step].join('\n');
}

function renderClarification(input: ResponseInput): string {
  const question = input.clarification_question
    ?? 'Could you please provide more details about your concern?';
  return [
    `Thank you for getting in touch.`, ``,
    `To make sure we assist you in the best way possible, we have a quick question:`, ``,
    question, ``, input.next_step,
  ].join('\n');
}

function renderTicketConfirmation(input: ResponseInput): string {
  const actionLines = input.actions_taken.map((a: string) => `• ${a}`).join('\n');
  return [
    `Thank you for bringing this to our attention. We have received your concern regarding:`, ``,
    `"${input.intent_summary}"`, ``,
    `Here is what we have done:`, actionLines, ``, input.next_step,
  ].join('\n');
}

function renderCriticalActionConfirmation(input: ResponseInput): string {
  const actionLines = input.actions_taken.map((a: string) => `• ${a}`).join('\n');

  // Slice 2: honest card-block offer wording
  const cardBlockSection = input.card_block_offered
    ? [
        ``,
        `For your protection, we would also like to place a temporary block on your card ` +
        `while we investigate. Please reply with YES to confirm the block, or NO to keep your card active.`,
      ].join('\n')
    : '';

  return [
    `We have received your report and your case has been given the highest priority.`, ``,
    `Regarding your concern:`,
    `"${input.intent_summary}"`, ``,
    `Here is what we have done:`, actionLines,
    cardBlockSection, ``,
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
// Step 3: Dispatch
// ---------------------------------------------------------------------------

function buildMessage(input: ResponseInput, extra: { cardBlockOutcome?: 'confirmed' | 'declined' | null }): string {
  // Card-block confirmation is a special case — handled before mode dispatch
  if (extra.cardBlockOutcome === 'confirmed') return renderCardBlockConfirmed();
  if (extra.cardBlockOutcome === 'declined')  return renderCardBlockDeclined();

  // TODO: LLM_HOOK — Replace this switch with an LLM call that receives
  // `input` as a structured prompt. Keep renderCard* templates as fallbacks.
  switch (input.response_mode) {
    case 'informational':               return renderInformational(input);
    case 'clarification':               return renderClarification(input);
    case 'ticket_confirmation':         return renderTicketConfirmation(input);
    case 'critical_action_confirmation':return renderCriticalActionConfirmation(input);
    case 'multi_issue_confirmation':    return renderTicketConfirmation(input); // Slice 3
    case 'refusal':                     return renderRefusal(input);
    default:                            return renderClarification(input);
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function generateResponse(input: ResponseAgentInput): string {
  const responseInput = buildResponseInput(input);
  return buildMessage(responseInput, { cardBlockOutcome: input.cardBlockOutcome });
}