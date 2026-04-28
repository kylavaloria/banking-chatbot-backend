// ─────────────────────────────────────────────────────────────────────────────
// Response Agent — Slice 4: Mistral with template fallback
// Slice 4 change: Gemini → Mistral for response generation
// ─────────────────────────────────────────────────────────────────────────────

import type { ActionResult }         from '../contracts/action.contract';
import type { IntentResult }         from '../contracts/intent.contract';
import type { TriageResult }         from '../contracts/triage.contract';
import type { ResponseInput }        from '../contracts/response.contract';
import type { PolicyOutput }         from './policy.agent';
import type { ClarificationContext } from './intent.agent';

import { callMistral }             from '../llm/mistral';
import { buildResponseMessages }   from '../llm/prompts/response.prompt';
import { env }                     from '../config/env';

export interface ResponseAgentInput {
  actionResult:              ActionResult;
  intentResult:              IntentResult;
  triageResult?:             TriageResult;
  policyOutput:              PolicyOutput;
  clarificationContext?:     ClarificationContext | null;
  cardBlockOutcome?:         'confirmed' | 'declined' | null;
  hybridInformationalAnswer?:string | null;
  topicSwitched?:            boolean;
  emotionLabel?:             string;
}

// ---------------------------------------------------------------------------
// ResponseInput builder
// ---------------------------------------------------------------------------

function buildActionsTakenList(actionResult: ActionResult, topicSwitched?: boolean): string[] {
  switch (actionResult.response_mode) {
    case 'ticket_confirmation':
      return [
        topicSwitched
          ? 'A new support case has been opened for your new concern.'
          : 'A support case has been opened for your concern.',
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
        'A support case has been opened for your concerns.',
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
      if (topicSwitched)
        return 'Your new concern is being handled separately. Our team will follow up on both cases.';
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
  const intentSummary = intentResult.issue_components[0]?.summary
    ?? `Your concern regarding ${intentLabel}`;

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
// Template renderer (used as fallback when Mistral fails)
// ---------------------------------------------------------------------------

function renderTemplate(
  input: ResponseInput,
  extra: {
    cardBlockOutcome?: 'confirmed' | 'declined' | null;
    hybridAnswer?:     string | null;
    topicSwitched?:    boolean;
    actionResult:      ActionResult;
  }
): string {
  if (extra.cardBlockOutcome === 'confirmed') {
    return [
      'Understood. Your card block has been confirmed.',
      '',
      'Your card has been temporarily blocked to prevent any further unauthorised use. Our team is actively reviewing your case and will follow up with you shortly.',
      '',
      'If you need to use your card before our team contacts you, please call our support line directly.',
    ].join('\n');
  }

  if (extra.cardBlockOutcome === 'declined') {
    return [
      'Understood — your card will remain active.',
      '',
      'Your case has been escalated to our team for urgent review. We will follow up with you as soon as possible.',
      '',
      'If you change your mind about blocking your card or notice any further suspicious activity, please contact us immediately.',
    ].join('\n');
  }

  if (extra.hybridAnswer && input.response_mode !== 'informational') {
    const actionLines = input.actions_taken.map(a => `• ${a}`).join('\n');
    return [
      'Thank you for your message. We have noted two parts to your inquiry:',
      '',
      'Regarding your question:',
      extra.hybridAnswer,
      '',
      'Regarding your concern:',
      `"${input.intent_summary}"`,
      '',
      'Here is what we have done:',
      actionLines,
      '',
      input.next_step,
    ].join('\n');
  }

  switch (input.response_mode) {
    case 'informational':
      return [
        'Thank you for reaching out.',
        '',
        input.informational_answer ?? 'We have noted your inquiry and will provide the relevant information.',
        '',
        input.next_step,
      ].join('\n');

    case 'clarification':
      return [
        'Thank you for getting in touch.',
        '',
        'To make sure we assist you in the best way possible, we have a quick question:',
        '',
        input.clarification_question ?? 'Could you please provide more details about your concern?',
        '',
        input.next_step,
      ].join('\n');

    case 'ticket_confirmation': {
      const actionLines = input.actions_taken.map(a => `• ${a}`).join('\n');
      const topicNote   = extra.topicSwitched
        ? '\n\nWe noticed this is a different concern from your previous case. We have opened a new case for this issue.'
        : '';
      return [
        'Thank you for bringing this to our attention. We have received your concern regarding:',
        '',
        `"${input.intent_summary}"`,
        topicNote,
        '',
        'Here is what we have done:',
        actionLines,
        '',
        input.next_step,
      ].join('\n');
    }

    case 'critical_action_confirmation': {
      const actionLines  = input.actions_taken.map(a => `• ${a}`).join('\n');
      const topicNote    = extra.topicSwitched
        ? '\n\nThis is being treated as a new case separate from any previous concern.'
        : '';
      const cardBlockNote = input.card_block_offered
        ? '\n\nFor your protection, we would also like to place a temporary block on your card while we investigate. Please reply with YES to confirm the block, or NO to keep your card active.'
        : '';
      return [
        'We have received your report and your case has been given the highest priority.',
        '',
        'Regarding your concern:',
        `"${input.intent_summary}"`,
        topicNote,
        '',
        'Here is what we have done:',
        actionLines,
        cardBlockNote,
        '',
        input.next_step,
      ].join('\n');
    }

    case 'multi_issue_confirmation': {
      const actionLines = input.actions_taken.map(a => `• ${a}`).join('\n');
      const count       = extra.actionResult.created_ticket_ids?.length ?? 0;
      return [
        `Thank you for reaching out. We have received your message and identified ${count} separate concern${count !== 1 ? 's' : ''}.`,
        '',
        'Here is what we have done:',
        actionLines,
        '',
        'Each concern is being tracked independently so our team can address them separately.',
        '',
        input.next_step,
      ].join('\n');
    }

    case 'refusal':
      return [
        'Thank you for reaching out.',
        '',
        'We are a dedicated BFSI customer support service and are only able to assist with banking, financial services, and insurance-related concerns — such as account issues, transactions, cards, loans, and related inquiries.',
        '',
        'We are unable to assist with the request you have described.',
        '',
        input.next_step,
      ].join('\n');

    default:
      return [
        'Thank you for getting in touch.',
        '',
        'Could you please provide more details about your concern?',
        '',
        input.next_step,
      ].join('\n');
  }
}

// ---------------------------------------------------------------------------
// Mistral generation
// ---------------------------------------------------------------------------

async function generateWithMistral(
  input: ResponseInput,
  extra: {
    cardBlockOutcome?: 'confirmed' | 'declined' | null;
    hybridAnswer?:     string | null;
    topicSwitched?:    boolean;
    ticketCount?:      number;
    emotionLabel?:     string;
  }
): Promise<string | null> {
  try {
    const messages = buildResponseMessages(input, {
      hybridInformationalAnswer: extra.hybridAnswer ?? null,
      topicSwitched:             extra.topicSwitched,
      ticketCount:               extra.ticketCount,
      cardBlockOutcome:          extra.cardBlockOutcome,
      emotionLabel:              extra.emotionLabel,
    });

    const llmResponse = await callMistral({
      messages,
      model:       env.RESPONSE_MODEL,
      temperature: 0.4,
      maxTokens:   512,
    });

    const text = llmResponse.text.trim();
    if (!text || text.length < 10) {
      console.warn('[ResponseAgent] Mistral returned empty or too-short response');
      return null;
    }
    return text;
  } catch (err) {
    console.warn(
      '[ResponseAgent] Mistral generation failed, using template fallback',
      err instanceof Error ? err.message : err
    );
    return null;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function generateResponse(input: ResponseAgentInput): Promise<string> {
  const responseInput = buildResponseInput(input);
  const extra = {
    cardBlockOutcome: input.cardBlockOutcome,
    hybridAnswer:     input.hybridInformationalAnswer ?? null,
    topicSwitched:    input.topicSwitched ?? false,
    actionResult:     input.actionResult,
    ticketCount:      input.actionResult.created_ticket_ids?.length,
    emotionLabel:     input.emotionLabel,
  };

  if (env.NODE_ENV === 'test') {
    return renderTemplate(responseInput, extra);
  }

  // Informational: use RAG or action-agent placeholder text verbatim (template wrap only).
  // Mistral is not given the KB facts in its brief; paraphrase would distort amounts/currency.
  if (input.actionResult.response_mode === 'informational') {
    return renderTemplate(responseInput, extra);
  }

  const llmText = await generateWithMistral(responseInput, extra);
  if (llmText) return llmText;

  return renderTemplate(responseInput, extra);
}
