// ─────────────────────────────────────────────────────────────────────────────
// Entry Route — Phase 2, Slice 1
// Single entry point for all messages coming from POST /api/chat/message.
//
// Responsibilities:
//   1. Load conversation context (session + recent messages + active case)
//   2. Run the Intent Agent
//   3. Branch:
//        out_of_scope / malicious → Conversation Manager (refusal)
//        informational            → Conversation Manager (informational)
//        operational              → Conversation Manager (full pipeline)
//        ambiguous / unclear      → Conversation Manager (clarification)
//   4. Return OrchestratorResult to the route
//
// NOT implemented in Slice 1: RAG, multi-issue, hybrid, topic switching.
// ─────────────────────────────────────────────────────────────────────────────

import { serviceClient }           from '../config/supabase';
import { classifyIntent }          from '../agents/intent.agent';
import { runConversationManager }  from './conversation-manager';

import type {
  PipelineContext,
  ConversationContext,
  ActiveCaseContext,
  RecentMessage,
  OrchestratorResult,
} from '../contracts/orchestration.contract';

// ---------------------------------------------------------------------------
// How many recent messages to load for intent classification context
// ---------------------------------------------------------------------------

const RECENT_MESSAGE_LIMIT = 6;

// ---------------------------------------------------------------------------
// Load conversation context from Supabase
// ---------------------------------------------------------------------------

async function loadConversationContext(
  customerId: string,
  sessionId:  string
): Promise<ConversationContext> {

  // Load recent messages for this session
  const { data: messageRows, error: msgError } = await serviceClient
    .from('messages')
    .select('sender_type, message_text, response_mode, created_at')
    .eq('session_id', sessionId)
    .order('created_at', { ascending: false })
    .limit(RECENT_MESSAGE_LIMIT);

  if (msgError) {
    throw { status: 500, message: 'Entry Route: failed to load recent messages.' };
  }

  // Reverse so oldest-first for agent consumption
  const recentMessages: RecentMessage[] = (messageRows ?? [])
    .reverse()
    .map(row => ({
      sender_type:   row.sender_type as RecentMessage['sender_type'],
      message_text:  row.message_text,
      response_mode: row.response_mode ?? null,
      created_at:    row.created_at,
    }));

  // Load active case for this session if one exists
  const { data: sessionRow, error: sessionError } = await serviceClient
    .from('chat_sessions')
    .select('current_case_id')
    .eq('session_id', sessionId)
    .single();

  if (sessionError) {
    throw { status: 500, message: 'Entry Route: failed to load session.' };
  }

  let activeCase: ActiveCaseContext | null = null;

  if (sessionRow?.current_case_id) {
    const { data: caseRow, error: caseError } = await serviceClient
      .from('cases')
      .select('case_id, primary_intent_type, status, stage, summary')
      .eq('case_id', sessionRow.current_case_id)
      .maybeSingle();

    if (caseError) {
      throw { status: 500, message: 'Entry Route: failed to load active case.' };
    }

    if (caseRow) {
      activeCase = {
        case_id:              caseRow.case_id,
        primary_intent_type:  caseRow.primary_intent_type,
        status:               caseRow.status  as ActiveCaseContext['status'],
        stage:                caseRow.stage,
        summary:              caseRow.summary,
      };
    }
  }

  return {
    customer_id:      customerId,
    session_id:       sessionId,
    active_case:      activeCase,
    recent_messages:  recentMessages,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Processes a single user message end-to-end and returns an OrchestratorResult.
 * The route is responsible for persisting messages before and after this call.
 */
export async function processMessage(
  customerId:  string,
  sessionId:   string,
  userMessage: string
): Promise<OrchestratorResult> {

  // ── Step 1: Load context ──────────────────────────────────────────────────
  const conversation = await loadConversationContext(customerId, sessionId);

  // ── Step 2: Intent Agent ──────────────────────────────────────────────────
  const intentResult = await classifyIntent({
    userMessage,
    recentMessages: conversation.recent_messages,
    activeCase:     conversation.active_case,
  });

  // ── Step 3: Build pipeline context ───────────────────────────────────────
  const pipelineCtx: PipelineContext = {
    conversation,
    user_message:  userMessage,
    intent_result: intentResult,
  };

  // ── Step 4: Route to Conversation Manager ────────────────────────────────
  // All branches go through the Conversation Manager in Slice 1.
  // The Policy Agent inside it handles the per-branch logic.
  return runConversationManager(pipelineCtx);
}