// ─────────────────────────────────────────────────────────────────────────────
// Orchestration Contract — updated for Slice 3
// Additions: HybridResult, hybrid_result on OrchestratorResult
// ─────────────────────────────────────────────────────────────────────────────

import type { IntentResult }    from './intent.contract';
import type { TriageResult }    from './triage.contract';
import type { PolicyDecision }  from './policy.contract';
import type { ActionResult, ResponseMode } from './action.contract';

export interface ActiveCaseContext {
  case_id:             string;
  primary_intent_type: string;
  status:              'open' | 'escalated' | 'resolved' | 'closed';
  stage:               string;
  summary:             string;
}

export interface RecentMessage {
  sender_type:   'user' | 'assistant' | 'system';
  message_text:  string;
  response_mode?: string | null;
  created_at:    string;
}

export interface ConversationContext {
  customer_id:     string;
  session_id:      string;
  active_case:     ActiveCaseContext | null;
  recent_messages: RecentMessage[];
}

export interface PipelineContext {
  conversation:  ConversationContext;
  user_message:  string;
  intent_result?:  IntentResult;
  triage_result?:  TriageResult;
  policy_decision?: PolicyDecision;
  action_result?:  ActionResult;
  assistant_text?: string;
}

// ---------------------------------------------------------------------------
// Slice 3: HybridResult
// Produced when a message contains both informational and operational concerns.
// The informational branch never creates a case or ticket.
// ---------------------------------------------------------------------------

export interface HybridResult {
  /** Plain-text informational answer (placeholder until RAG in Slice 5) */
  informational_answer: string;
  /** The intent type of the informational component */
  informational_intent: string;
  /** The full OrchestratorResult from the operational branch */
  operational_result:   OrchestratorResult;
}

export interface OrchestratorResult {
  assistant_text: string;
  response_mode:  ResponseMode;
  session_id:     string;
  message_id:     string;
  case_id?:       string | null;
  ticket_id?:     string | null;
  /** Populated only for multi-issue cases */
  ticket_ids?:    string[];
  /** Populated only for hybrid responses */
  hybrid_result?: HybridResult;
  /** True when a topic switch caused a new case to be created */
  topic_switched?: boolean;
  debug?: {
    intent_result?:   IntentResult;
    triage_result?:   TriageResult;
    policy_decision?: PolicyDecision;
    action_result?:   ActionResult;
  };
}