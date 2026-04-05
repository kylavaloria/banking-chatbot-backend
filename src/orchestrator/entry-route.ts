// ─────────────────────────────────────────────────────────────────────────────
// Entry Route — Phase 2, Slice 1 + Slice 2
// Slice 2 additions:
//   - Malicious input gate runs before any branch (including card-block)
//   - Card-block confirmation branch (detected before pipeline runs)
//   - Clarification context loaded from message history and passed to Intent Agent
// ─────────────────────────────────────────────────────────────────────────────

import { serviceClient }                from '../config/supabase';
import { classifyIntent }               from '../agents/intent.agent';
import { executeCardBlockConfirmation } from '../agents/action.agent';
import { generateResponse }             from '../agents/response.agent';
import { runConversationManager }       from './conversation-manager';

import {
  CARD_BLOCK_CONFIRM_PHRASES,
  CARD_BLOCK_DECLINE_PHRASES,
  CLARIFICATION_CANDIDATE_INTENTS,
} from '../constants/intent-taxonomy';

import {
  PROMPT_INJECTION_SUBSTRINGS,
  PROMPT_INJECTION_PATTERNS,
  DATA_EXFILTRATION_SUBSTRINGS,
} from '../constants/malicious-patterns';

import type {
  PipelineContext,
  ConversationContext,
  ActiveCaseContext,
  RecentMessage,
  OrchestratorResult,
} from '../contracts/orchestration.contract';

import type { ClarificationContext }  from '../agents/intent.agent';
import type { SupportedIntentType }   from '../contracts/intent.contract';

const RECENT_MESSAGE_LIMIT = 8;

// ---------------------------------------------------------------------------
// Malicious input detection
// Mirrors the logic in intent.agent.ts but runs here independently so that
// the safety gate fires before any branch — including card-block confirmation.
// ---------------------------------------------------------------------------

function isMaliciousInput(normalizedText: string): boolean {
  for (const phrase of DATA_EXFILTRATION_SUBSTRINGS) {
    if (normalizedText.includes(phrase)) return true;
  }
  for (const phrase of PROMPT_INJECTION_SUBSTRINGS) {
    if (normalizedText.includes(phrase)) return true;
  }
  for (const pattern of PROMPT_INJECTION_PATTERNS) {
    if (pattern.test(normalizedText)) return true;
  }
  return false;
}

const REFUSAL_TEXT = [
  `Thank you for reaching out.`,
  ``,
  `We are a dedicated BFSI customer support service and are only able to assist with ` +
  `banking, financial services, and insurance-related concerns — such as account issues, ` +
  `transactions, cards, loans, and related inquiries.`,
  ``,
  `We are unable to assist with the request you have described.`,
  ``,
  `If you have a banking or account-related concern, please describe it and we will be glad to assist.`,
].join('\n');

// ---------------------------------------------------------------------------
// Load conversation context
// ---------------------------------------------------------------------------

async function loadConversationContext(
  customerId: string,
  sessionId:  string
): Promise<ConversationContext> {
  const { data: messageRows, error: msgError } = await serviceClient
    .from('messages')
    .select('sender_type, message_text, response_mode, created_at')
    .eq('session_id', sessionId)
    .order('created_at', { ascending: false })
    .limit(RECENT_MESSAGE_LIMIT);

  if (msgError) throw { status: 500, message: 'Entry Route: failed to load recent messages.' };

  const recentMessages: RecentMessage[] = (messageRows ?? [])
    .reverse()
    .map(row => ({
      sender_type:   row.sender_type as RecentMessage['sender_type'],
      message_text:  row.message_text,
      response_mode: row.response_mode ?? null,
      created_at:    row.created_at,
    }));

  const { data: sessionRow, error: sessionError } = await serviceClient
    .from('chat_sessions')
    .select('current_case_id')
    .eq('session_id', sessionId)
    .single();

  if (sessionError) throw { status: 500, message: 'Entry Route: failed to load session.' };

  let activeCase: ActiveCaseContext | null = null;

  if (sessionRow?.current_case_id) {
    const { data: caseRow, error: caseError } = await serviceClient
      .from('cases')
      .select('case_id, primary_intent_type, status, stage, summary, card_block_status')
      .eq('case_id', sessionRow.current_case_id)
      .maybeSingle();

    if (caseError) throw { status: 500, message: 'Entry Route: failed to load active case.' };

    if (caseRow) {
      activeCase = {
        case_id:             caseRow.case_id,
        primary_intent_type: caseRow.primary_intent_type,
        status:              caseRow.status as ActiveCaseContext['status'],
        stage:               caseRow.stage,
        summary:             caseRow.summary,
      };
      (activeCase as any)._card_block_status = caseRow.card_block_status;
    }
  }

  return {
    customer_id:     customerId,
    session_id:      sessionId,
    active_case:     activeCase,
    recent_messages: recentMessages,
  };
}

// ---------------------------------------------------------------------------
// Derive clarification context from recent message history
// ---------------------------------------------------------------------------

function deriveClarificationContext(
  recentMessages: RecentMessage[]
): ClarificationContext | null {
  const lastAssistant = [...recentMessages]
    .reverse()
    .find(m => m.sender_type === 'assistant');

  if (!lastAssistant || lastAssistant.response_mode !== 'clarification') return null;

  let turnCount = 0;
  for (const msg of [...recentMessages].reverse()) {
    if (msg.sender_type === 'assistant' && msg.response_mode === 'clarification') {
      turnCount++;
    } else if (msg.sender_type === 'assistant') {
      break;
    }
  }

  return {
    question:         lastAssistant.message_text,
    candidateIntents: CLARIFICATION_CANDIDATE_INTENTS,
    turnCount,
  };
}

// ---------------------------------------------------------------------------
// Card-block confirmation detection
// ---------------------------------------------------------------------------

function detectCardBlockResponse(
  normalizedText: string
): 'confirmed' | 'declined' | null {
  if (CARD_BLOCK_CONFIRM_PHRASES.some(p => normalizedText.includes(p))) return 'confirmed';
  if (CARD_BLOCK_DECLINE_PHRASES.some(p => normalizedText.includes(p))) return 'declined';
  return null;
}

// ---------------------------------------------------------------------------
// Load the active ticket for a case
// ---------------------------------------------------------------------------

async function loadActiveTicketId(caseId: string): Promise<string | null> {
  const { data, error } = await serviceClient
    .from('tickets')
    .select('ticket_id')
    .eq('case_id', caseId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error || !data) return null;
  return data.ticket_id;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function processMessage(
  customerId:  string,
  sessionId:   string,
  userMessage: string,
  persistFn: (params: {
    sessionId:    string;
    caseId:       string | null;
    ticketId?:    string | null;
    senderType:   'user' | 'assistant' | 'system';
    messageText:  string;
    responseMode?: string | null;
  }) => Promise<{ message_id: string }>
): Promise<OrchestratorResult> {

  // ── Step 1: Load context ──────────────────────────────────────────────────
  const conversation = await loadConversationContext(customerId, sessionId);
  const { active_case: activeCase, recent_messages } = conversation;

  // ── Step 2: Malicious input gate ──────────────────────────────────────────
  // Must run before every other branch — including card-block confirmation.
  // Prompt injection attempts are refused regardless of session state.
  const normalizedText = userMessage.toLowerCase().trim();

  if (isMaliciousInput(normalizedText)) {
    const saved = await persistFn({
      sessionId,
      caseId:      null,
      senderType:  'assistant',
      messageText: REFUSAL_TEXT,
      responseMode:'refusal',
    });

    return {
      assistant_text: REFUSAL_TEXT,
      response_mode:  'refusal',
      session_id:     sessionId,
      message_id:     saved.message_id,
      case_id:        null,
      ticket_id:      null,
    };
  }

  // ── Step 3: Card-block confirmation branch ────────────────────────────────
  const rawCardBlockStatus = (activeCase as any)?._card_block_status;
  const isAwaitingCardBlock =
    activeCase?.stage === 'awaiting_card_block_confirmation' &&
    rawCardBlockStatus === 'offered';

  if (isAwaitingCardBlock && activeCase) {
    const cardBlockOutcome = detectCardBlockResponse(normalizedText);

    if (cardBlockOutcome !== null) {
      const ticketId = await loadActiveTicketId(activeCase.case_id);

      await executeCardBlockConfirmation({
        caseId:    activeCase.case_id,
        ticketId,
        confirmed: cardBlockOutcome === 'confirmed',
      });

      const stubIntentResult = {
        intent_type:    activeCase.primary_intent_type as SupportedIntentType,
        intent_group:   'operational' as const,
        confidence:     1.0,
        secondary_intents: [] as SupportedIntentType[],
        entities: {
          product: null, amount: null, date_reference: null,
          channel: null, reference_number: null, urgency_cue: null, reported_action: null,
        },
        flags: {
          ambiguous: false, multi_issue: false, hybrid: false,
          topic_switch: false, malicious_input: false,
        },
        issue_components:                    [],
        candidate_intents_for_clarification: [] as SupportedIntentType[],
        consistency_with_active_case:        'same_case' as const,
        evidence: ['Card-block confirmation branch'],
      };

      const stubPolicyOutput = {
        decision: {
          allowed_actions:         [] as any[],
          next_policy_step:        'standard_operational_flow' as const,
          requires_human_support:  true,
          requires_live_escalation:false,
          refusal_reason:          'none' as const,
          card_block_eligible:     true,
          split_required:          false,
        },
        plan: {
          case_required:        false,
          ticket_required:      false,
          live_escalation_required: false,
          offer_card_block:     false,
          split_required:       false,
          informational_only:   false,
          clarification_only:   false,
          refusal_only:         false,
          response_mode:        'critical_action_confirmation' as const,
        },
        tone:     'reassuring' as const,
        evidence: [],
      };

      const stubActionResult = {
        response_mode:       'critical_action_confirmation' as const,
        case_id:             activeCase.case_id,
        ticket_id:           ticketId,
        created_ticket_ids:  ticketId ? [ticketId] : [],
        stage_after_action:  cardBlockOutcome === 'confirmed'
                               ? 'ticket_created' as const
                               : 'live_escalation_triggered' as const,
        informational_payload: null,
        clarification_payload: null,
        refusal_payload:       null,
        execution_summary:     [`card_block_${cardBlockOutcome}`],
      };

      const assistantText = generateResponse({
        actionResult:    stubActionResult,
        intentResult:    stubIntentResult,
        policyOutput:    stubPolicyOutput,
        cardBlockOutcome,
      });

      const saved = await persistFn({
        sessionId,
        caseId:      activeCase.case_id,
        ticketId,
        senderType:  'assistant',
        messageText: assistantText,
        responseMode:'critical_action_confirmation',
      });

      return {
        assistant_text: assistantText,
        response_mode:  'critical_action_confirmation',
        session_id:     sessionId,
        message_id:     saved.message_id,
        case_id:        activeCase.case_id,
        ticket_id:      ticketId,
      };
    }
    // If yes/no cannot be parsed, fall through to normal pipeline
  }

  // ── Step 4: Derive clarification context from history ─────────────────────
  const clarificationContext = deriveClarificationContext(recent_messages);

  // ── Step 5: Intent Agent ──────────────────────────────────────────────────
  const intentResult = await classifyIntent({
    userMessage,
    recentMessages: recent_messages,
    activeCase,
    clarificationContext,
  });

  // ── Step 6: Build pipeline context and run Conversation Manager ───────────
  const pipelineCtx: PipelineContext = {
    conversation,
    user_message:  userMessage,
    intent_result: intentResult,
  };

  return runConversationManager(pipelineCtx, clarificationContext);
}