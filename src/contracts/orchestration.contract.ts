// ─────────────────────────────────────────────────────────────────────────────
// Orchestration Contract
// Defines the shared context types and top-level result that flow through
// the Entry Route and Conversation Manager.
// ─────────────────────────────────────────────────────────────────────────────

import type { IntentResult } from './intent.contract';
import type { TriageResult } from './triage.contract';
import type { PolicyDecision } from './policy.contract';
import type { ActionResult, ResponseMode } from './action.contract';

// ---------------------------------------------------------------------------
// Active case context — a safe projection of the cases DB row
// Passed to agents so they have case state without seeing raw DB rows.
// ---------------------------------------------------------------------------

export interface ActiveCaseContext {
  case_id: string;
  primary_intent_type: string;
  status: 'open' | 'escalated' | 'resolved' | 'closed';
  stage: string;
  /** Brief human-readable summary of the concern */
  summary: string;
}

// ---------------------------------------------------------------------------
// Recent message — a safe projection of a messages DB row
// Used to give agents conversation history without raw DB row access.
// ---------------------------------------------------------------------------

export interface RecentMessage {
  sender_type: 'user' | 'assistant' | 'system';
  message_text: string;
  response_mode?: string | null;
  created_at: string;
}

// ---------------------------------------------------------------------------
// ConversationContext — loaded at the start of each /api/chat/message request
// Passed to the Entry Route and from there into each agent that needs it.
// ---------------------------------------------------------------------------

export interface ConversationContext {
  customer_id: string;
  session_id: string;
  /** Null when no case is currently open for this session */
  active_case: ActiveCaseContext | null;
  /**
   * Most recent N messages for the session (newest last).
   * Used by the Intent Agent for history-aware classification.
   */
  recent_messages: RecentMessage[];
}

// ---------------------------------------------------------------------------
// PipelineContext — the shared envelope that passes through
// Entry Route → Conversation Manager → each agent in sequence.
// Agents append their results; downstream agents read upstream results.
// ---------------------------------------------------------------------------

export interface PipelineContext {
  /** Resolved from the authenticated session at request start */
  conversation: ConversationContext;
  /** The raw text of the current user message */
  user_message: string;

  // ── Results appended sequentially as the pipeline executes ──

  /** Set by the Intent Agent */
  intent_result?: IntentResult;
  /** Set by the Triage Agent (undefined for non-operational branches) */
  triage_result?: TriageResult;
  /** Set by the Policy Agent */
  policy_decision?: PolicyDecision;
  /** Set by the Action Agent */
  action_result?: ActionResult;
  /** Set by the Response Agent — the final text returned to the user */
  assistant_text?: string;
}

// ---------------------------------------------------------------------------
// OrchestratorResult — what /api/chat/message returns to the API layer
// ---------------------------------------------------------------------------

export interface OrchestratorResult {
  /** The final assistant message text to return to the user */
  assistant_text: string;
  /** Response mode — determines how the frontend renders the response */
  response_mode: ResponseMode;
  /** The session this message belongs to */
  session_id: string;
  /** The message ID of the persisted assistant message */
  message_id: string;
  /** Case created in this turn (null if no case was created) */
  case_id?: string | null;
  /** Primary ticket created in this turn (null if no ticket was created) */
  ticket_id?: string | null;
  /**
   * Debug payload — include only in development/staging environments.
   * Never expose this in production responses.
   * Gate it with: if (process.env.NODE_ENV !== 'production')
   */
  debug?: {
    intent_result?: IntentResult;
    triage_result?: TriageResult;
    policy_decision?: PolicyDecision;
    action_result?: ActionResult;
  };
}