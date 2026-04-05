// ─────────────────────────────────────────────────────────────────────────────
// Policy Contract
// The Policy Agent is purely rule-based — no LLM, no DB writes.
// It reads IntentResult + TriageResult and declares what is allowed.
// The Action Agent only executes what is declared here.
// ─────────────────────────────────────────────────────────────────────────────

// ---------------------------------------------------------------------------
// Allowed actions — strict SRS whitelist (FR §7.2)
// Any action not in this set is never executed.
// ---------------------------------------------------------------------------

export type AllowedAction =
  | 'provide_information'       // FR-POL-03: informational path
  | 'create_case'               // FR-POL-04: operational baseline
  | 'create_ticket'             // FR-POL-04: operational baseline
  | 'offer_temporary_card_block'// FR-POL-05: card-related intents only
  | 'live_escalation';          // FR-POL-06: P1 only

// ---------------------------------------------------------------------------
// Next policy step — drives the Action Agent's execution branch
// ---------------------------------------------------------------------------

export type NextPolicyStep =
  | 'clarification_loop'          // FR-POL-01: ambiguous input
  | 'refusal'                     // FR-POL-08: out-of-scope or malicious
  | 'provide_information'         // FR-POL-03: informational only
  | 'standard_operational_flow'   // FR-POL-04: P2/P3 operational
  | 'split_into_multiple_tickets' // FR-POL-02: multi-issue
  | 'live_escalation_flow';       // FR-POL-06: P1

// ---------------------------------------------------------------------------
// Refusal reason — populated only when next_policy_step = 'refusal'
// ---------------------------------------------------------------------------

export type RefusalReason =
  | 'none'                // Not a refusal
  | 'unsupported_request' // FR-INT-09: out-of-scope request
  | 'malicious_input';    // FR-INT-10: prompt injection or exfiltration attempt

// ---------------------------------------------------------------------------
// PolicyDecision — output of the Policy Agent
//
// SRS policy rule summary:
//   Ambiguous                 → clarification_loop; no actions
//   Informational (non-hybrid)→ provide_information only
//   P3 / P2 operational       → create_case + create_ticket
//   P1 operational            → create_case + create_ticket + live_escalation
//   Card-related (additive)   → + offer_temporary_card_block
//   Out-of-scope / Malicious  → no actions; refusal
//   Multi-issue               → create_case + create_ticket (split path)
// ---------------------------------------------------------------------------

export interface PolicyDecision {
  /** Ordered list of actions the Action Agent is permitted to execute */
  allowed_actions: AllowedAction[];
  /** Which execution branch the Action Agent should follow */
  next_policy_step: NextPolicyStep;
  /**
   * True when the concern requires a human agent to handle it.
   * False for informational-only and refusal responses.
   */
  requires_human_support: boolean;
  /**
   * True only for P1 cases where live escalation is the path.
   * Subset of requires_human_support = true.
   */
  requires_live_escalation: boolean;
  /** Populated when next_policy_step = 'refusal'; 'none' otherwise */
  refusal_reason: RefusalReason;
  /**
   * True when offer_temporary_card_block is permitted.
   * Only applies for lost_or_stolen_card and unauthorized_transaction.
   */
  card_block_eligible: boolean;
  /**
   * True when the message maps to multiple operational intents.
   * Drives the split_into_multiple_tickets execution path.
   */
  split_required: boolean;
}