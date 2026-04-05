// ─────────────────────────────────────────────────────────────────────────────
// Response Agent — Phase 2, Slice 1
// Generates user-facing message text from ResponseInput.
//
// Rules (SRS FR-RES-*):
//   - Works strictly from response_mode — no business logic
//   - Follows structure: Acknowledge → Action taken → Next step (FR-RES-02)
//   - Tone matches response_mode (FR-RES-03)
//   - No internal IDs exposed (FR-RES-09)
//   - No system capabilities promised beyond what ActionResult confirmed
//   - No LLM in this slice — templated string generation only
//
// TODO: LLM_HOOK — Replace buildMessage() with an LLM call that receives
// ResponseInput as a structured prompt. Keep this file's public API
// (generateResponse) and the ResponseInput contract unchanged.
// ─────────────────────────────────────────────────────────────────────────────

import type { ActionResult } from '../contracts/action.contract';
import type { IntentResult } from '../contracts/intent.contract';
import type { TriageResult } from '../contracts/triage.contract';
import type { ResponseInput } from '../contracts/response.contract';
import type { PolicyOutput } from './policy.agent';

// ---------------------------------------------------------------------------
// Input type for the Response Agent
// ---------------------------------------------------------------------------

export interface ResponseAgentInput {
  actionResult:  ActionResult;
  intentResult:  IntentResult;
  triageResult?: TriageResult;
  policyOutput:  PolicyOutput;
}

// ---------------------------------------------------------------------------
// Step 1: Build ResponseInput from pipeline outputs
// Shields the template layer from raw agent outputs.
// The Response Agent never reads case_id, ticket_id, or auth identifiers.
// ---------------------------------------------------------------------------

function buildResponseInput(input: ResponseAgentInput): ResponseInput {
  const { actionResult, intentResult, triageResult, policyOutput } = input;
  const mode = actionResult.response_mode;

  // Derive human-readable intent summary — never raw intent_type enum value
  const intentLabel = intentResult.intent_type.replace(/_/g, ' ');
  const intentSummary = intentResult.issue_components[0]?.summary
    ?? `Your concern regarding ${intentLabel}`;

  // Build actions_taken list from execution_summary, filtering internal notes
  const actionsTaken = buildActionsTakenList(actionResult);

  // Derive next_step text per response mode
  const nextStep = buildNextStep(mode, triageResult);

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

/**
 * Converts raw execution_summary entries into clean user-facing action strings.
 * Filters out internal technical entries (IDs, stage updates, session links).
 */
function buildActionsTakenList(actionResult: ActionResult): string[] {
  const actions: string[] = [];

  switch (actionResult.response_mode) {
    case 'ticket_confirmation':
    case 'critical_action_confirmation':
      actions.push('A support case has been opened for your concern.');
      actions.push('A support ticket has been created and assigned to our team.');
      if (actionResult.stage_after_action === 'live_escalation_triggered') {
        actions.push('Your case has been flagged for immediate escalation to a live agent.');
      }
      if (actionResult.stage_after_action === 'awaiting_card_block_confirmation') {
        actions.push('A temporary card block has been offered for your protection.');
      }
      break;
    case 'informational':
    case 'clarification':
    case 'refusal':
    default:
      break;
  }

  return actions;
}

/**
 * Generates the "next step" sentence based on response mode and priority.
 */
function buildNextStep(
  mode: ActionResult['response_mode'],
  triageResult?: TriageResult
): string {
  switch (mode) {
    case 'ticket_confirmation': {
      const priority = triageResult?.priority;
      if (priority === 'P2') {
        return 'Our team will review your case on a priority basis and follow up with you shortly.';
      }
      return 'Our team will review your ticket and get back to you within our standard service window.';
    }

    case 'critical_action_confirmation':
      return 'A support agent will be with you as soon as possible. Please stay available.';

    case 'informational':
      return 'Let us know if you have any other questions — we are here to help.';

    case 'clarification':
      return 'Your response will help us direct your concern to the right team right away.';

    case 'refusal':
      return 'If you have a banking or account-related concern, please describe it and we will be glad to assist.';

    default:
      return 'Please let us know if there is anything else we can help you with.';
  }
}

// ---------------------------------------------------------------------------
// Step 2: Template rendering per response_mode
// Each branch follows: Acknowledge → Action taken → Next step (FR-RES-02)
// Tone is embedded in word choice, not a runtime parameter.
// ---------------------------------------------------------------------------

function renderInformational(input: ResponseInput): string {
  const answer = input.informational_answer
    ?? 'We have noted your inquiry and will provide the relevant information.';

  return [
    `Thank you for reaching out.`,
    ``,
    answer,
    ``,
    input.next_step,
  ].join('\n');
}

function renderClarification(input: ResponseInput): string {
  const question = input.clarification_question
    ?? 'Could you please provide more details about your concern?';

  return [
    `Thank you for getting in touch.`,
    ``,
    `To make sure we assist you in the best way possible, we have a quick question:`,
    ``,
    question,
    ``,
    input.next_step,
  ].join('\n');
}

function renderTicketConfirmation(input: ResponseInput): string {
  const actionLines = input.actions_taken.length > 0
    ? input.actions_taken.map((a: string) => `• ${a}`).join('\n')
    : '• Your concern has been recorded.';

  return [
    `Thank you for bringing this to our attention. We have received your concern regarding:`,
    ``,
    `"${input.intent_summary}"`,
    ``,
    `Here is what we have done:`,
    actionLines,
    ``,
    input.next_step,
  ].join('\n');
}

function renderCriticalActionConfirmation(input: ResponseInput): string {
  const actionLines = input.actions_taken.length > 0
    ? input.actions_taken.map(a => `• ${a}`).join('\n')
    : '• Your concern has been escalated.';

  const cardBlockNote = input.card_block_offered
    ? '\n\nFor your protection, we have also offered a temporary block on your card while we investigate.'
    : '';

  return [
    `We understand the urgency of your situation and we are taking immediate action.`,
    ``,
    `Regarding your concern:`,
    `"${input.intent_summary}"`,
    ``,
    `Actions taken:`,
    actionLines,
    cardBlockNote,
    ``,
    input.next_step,
  ].join('\n');
}

function renderRefusal(input: ResponseInput): string {
  return [
    `Thank you for reaching out.`,
    ``,
    `We are a dedicated BFSI customer support service and are only able to assist with ` +
    `banking, financial services, and insurance-related concerns — such as account issues, ` +
    `transactions, cards, loans, and related inquiries.`,
    ``,
    `We are unable to assist with the request you have described.`,
    ``,
    input.next_step,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Step 3: Dispatch to correct template
// ---------------------------------------------------------------------------

function buildMessage(input: ResponseInput): string {
  // TODO: LLM_HOOK — Pass `input` as a structured prompt to an LLM here.
  // Return the LLM output after applying output filtering (FR-RES-10 / FR-SEC-LLM-11).
  // The switch below is the template fallback for the rule-based slice.

  switch (input.response_mode) {
    case 'informational':
      return renderInformational(input);

    case 'clarification':
      return renderClarification(input);

    case 'ticket_confirmation':
      return renderTicketConfirmation(input);

    case 'critical_action_confirmation':
      return renderCriticalActionConfirmation(input);

    case 'multi_issue_confirmation':
      // Slice 3 — fall back to ticket_confirmation template for now
      return renderTicketConfirmation(input);

    case 'refusal':
      return renderRefusal(input);

    default:
      return renderClarification(input);
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Generates the final user-facing assistant message.
 *
 * Returns only the text string. The orchestrator is responsible for
 * persisting it to the messages table and building OrchestratorResult.
 */
export function generateResponse(input: ResponseAgentInput): string {
  const responseInput = buildResponseInput(input);
  return buildMessage(responseInput);
}