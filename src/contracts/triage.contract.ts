// ─────────────────────────────────────────────────────────────────────────────
// Triage Contract
// Consumed only for operational concerns.
// Informational, clarification, and refusal branches bypass Triage entirely.
// ─────────────────────────────────────────────────────────────────────────────

// ---------------------------------------------------------------------------
// Importance / Urgency / Priority — mirror schema enum values exactly
// ---------------------------------------------------------------------------

export type Importance = 'low' | 'medium' | 'high';
export type Urgency    = 'low' | 'medium' | 'high';

/**
 * P1–P3 only for tracked operational cases.
 * P4 (self-service) is conceptual only per SRS CON-05;
 * tracked cases always create at minimum a P3 ticket.
 * P4 is included here for triage signal completeness only.
 */
export type Priority = 'P1' | 'P2' | 'P3' | 'P4';

export type RecommendedPath =
  | 'self_service'      // P4 — informational/self-service; no ticket
  | 'standard_ticket'   // P3
  | 'urgent_ticket'     // P2
  | 'live_escalation';  // P1

// ---------------------------------------------------------------------------
// SRS Priority Matrix (Importance × Urgency → Priority)
//
//              Urgency
//              low    medium  high
// Importance
//   low        P4     P3      P2
//   medium     P3     P2      P1
//   high       P2     P1      P1
//
// Override rules always take precedence — see TriageResult.override_reason
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// TriageSignals — extracted by the LLM, validated by rules
// The deterministic matrix and override rules read from these signals.
// LLM never computes final priority directly.
// ---------------------------------------------------------------------------

export interface TriageSignals {
  /** Active fraud or unauthorized transaction detected */
  active_fraud_signal: boolean;
  /** Account compromise or unauthorized access suspected */
  account_compromise_signal: boolean;
  /** Customer cannot access their funds */
  access_to_funds_blocked: boolean;
  /** Multiple transactions affected */
  multiple_transactions: boolean;
  /** Amount qualifies as high-value (threshold configurable) */
  high_value_amount: boolean;
  /** Case is aging or approaching SLA threshold */
  aging_signal: boolean;
  /** Urgency language detected in the message */
  urgency_language: 'low' | 'medium' | 'high';
  /** Estimated financial impact of the issue */
  financial_impact: 'low' | 'medium' | 'high';
  /**
   * Short strings explaining how signals were derived.
   * Used for auditing and debugging — not user-facing.
   */
  evidence: string[];
  /** Preserved raw LLM signal extraction output. Not used in business logic. */
  raw_llm_output?: unknown;
}

// ---------------------------------------------------------------------------
// Override reasons — P1 overrides applied unconditionally per SRS
// ---------------------------------------------------------------------------

export type TriageOverrideReason =
  | 'none'                          // No override; matrix result stands
  | 'fraud_override'                // Active fraud detected → P1
  | 'account_compromise_override'   // Account compromise detected → P1
  | 'no_access_to_funds_override'   // Customer locked out of funds → P1
  | 'sla_override';                 // SLA near breach or breached → P1

// ---------------------------------------------------------------------------
// TriageResult — final output of the Triage Agent
// Computed deterministically from TriageSignals using the priority matrix.
// ---------------------------------------------------------------------------

export interface TriageResult {
  /** Computed importance level */
  importance: Importance;
  /** Computed urgency level */
  urgency: Urgency;
  /** Final priority — matrix result unless an override applied */
  priority: Priority;
  /** Handling path derived from priority */
  recommended_path: RecommendedPath;
  /**
   * If a P1 override rule was applied, this identifies which rule fired.
   * 'none' means the priority matrix result was used without modification.
   */
  override_reason: TriageOverrideReason;
  /**
   * Short strings explaining the triage decision.
   * Used for audit trails and debugging.
   */
  evidence: string[];
}