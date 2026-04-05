// ─────────────────────────────────────────────────────────────────────────────
// Action Contract
// Splits "what to execute" (ActionPlan) from "what happened" (ActionResult).
// The Action Agent reads PolicyDecision + TriageResult and produces both.
// It never decides what is allowed — that is the Policy Agent's responsibility.
// ─────────────────────────────────────────────────────────────────────────────

import type { SupportedIntentType } from './intent.contract';

// ---------------------------------------------------------------------------
// Response mode — mirrors schema enum and SRS response modes exactly
// ---------------------------------------------------------------------------

export type ResponseMode =
  | 'informational'               // Informational-only action (RAG path)
  | 'clarification'               // Clarification loop entered
  | 'ticket_confirmation'         // Standard ticket created (P3/P2)
  | 'critical_action_confirmation'// P1 with live escalation and/or card block
  | 'multi_issue_confirmation'    // Multi-issue split completed
  | 'refusal';                    // Out-of-scope, malicious, or unsafe request

// ---------------------------------------------------------------------------
// Case stage — mirrors schema enum exactly
// ---------------------------------------------------------------------------

export type CaseStage =
  | 'initial'
  | 'clarification_loop'
  | 'case_created'
  | 'ticket_created'
  | 'awaiting_card_block_confirmation'
  | 'live_escalation_triggered'
  | 'split_ticket_created';

// ---------------------------------------------------------------------------
// ActionPlan — what the Action Agent is instructed to execute
// Derived by the Policy Agent from IntentResult + PolicyDecision.
// Pure data — no side effects.
// ---------------------------------------------------------------------------

export interface ActionPlan {
  /** A case record must be created */
  case_required: boolean;
  /** A ticket record must be created under the case */
  ticket_required: boolean;
  /** Live escalation must be triggered */
  live_escalation_required: boolean;
  /** A temporary card block must be offered to the customer */
  offer_card_block: boolean;
  /** Multi-issue decomposition; one ticket per operational component */
  split_required: boolean;
  /** Informational path only — no case or ticket created */
  informational_only: boolean;
  /** Clarification loop only — no case or ticket created */
  clarification_only: boolean;
  /** Refusal — no case, no ticket, no further action */
  refusal_only: boolean;
  /** Response mode that the Response Agent will use */
  response_mode: ResponseMode;
}

// ---------------------------------------------------------------------------
// Payload types for each non-operational branch
// ---------------------------------------------------------------------------

/** Populated for informational responses (placeholder until RAG) */
export interface InformationalPayload {
  answer_text: string;
  /** 'placeholder' now; 'rag' in Phase 2 Slice 5 */
  source_mode: 'placeholder' | 'rag';
}

/** Populated when clarification loop is entered */
export interface ClarificationPayload {
  /** The clarifying question to show the user */
  question: string;
  /** Candidate intents that the clarification is trying to distinguish */
  candidate_intents: SupportedIntentType[];
}

/** Populated when a refusal is issued */
export interface RefusalPayload {
  reason: 'unsupported_request' | 'malicious_input';
}

// ---------------------------------------------------------------------------
// ActionResult — what actually happened after execution
// Produced by the Action Agent and consumed by the Response Agent (via ResponseInput).
// ---------------------------------------------------------------------------

export interface ActionResult {
  /** Response mode to pass to the Response Agent */
  response_mode: ResponseMode;

  /** ID of the case created (null if no case was created) */
  case_id?: string | null;

  /** ID of the primary ticket created (null if no ticket was created) */
  ticket_id?: string | null;

  /**
   * IDs of all tickets created.
   * Has more than one entry only when split_required was true.
   */
  created_ticket_ids?: string[];

  /** The case stage after all actions completed */
  stage_after_action?: CaseStage | null;

  /** Populated only when response_mode = 'informational' */
  informational_payload?: InformationalPayload | null;

  /** Populated only when response_mode = 'clarification' */
  clarification_payload?: ClarificationPayload | null;

  /** Populated only when response_mode = 'refusal' */
  refusal_payload?: RefusalPayload | null;

  /**
   * Ordered log of what the Action Agent executed.
   * e.g. ['create_case', 'create_ticket', 'update_stage → ticket_created']
   * Used for debugging and audit trails — never user-facing.
   */
  execution_summary: string[];
}