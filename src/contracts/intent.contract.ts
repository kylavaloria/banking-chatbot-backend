// ─────────────────────────────────────────────────────────────────────────────
// Intent Contract
// Output of the Intent Agent. Consumed by Policy Agent (directly) and
// Triage Agent (operational branch only).
// ─────────────────────────────────────────────────────────────────────────────

// ---------------------------------------------------------------------------
// Intent group — top-level routing decision
// ---------------------------------------------------------------------------

export type IntentGroup =
  | 'informational'
  | 'operational'
  | 'out_of_scope';

// ---------------------------------------------------------------------------
// Full SRS intent taxonomy
// Informational (5), Operational (10), Special (3), Out-of-scope/Safety (1)
// ---------------------------------------------------------------------------

export type InformationalIntentType =
  | 'product_info'
  | 'requirements_inquiry'
  | 'policy_or_process_inquiry'
  | 'fee_or_rate_inquiry'
  | 'branch_or_service_info';

export type OperationalIntentType =
  | 'unauthorized_transaction'
  | 'lost_or_stolen_card'
  | 'failed_or_delayed_transfer'
  | 'refund_or_reversal_issue'
  | 'account_access_issue'
  | 'account_restriction_issue'
  | 'billing_or_fee_dispute'
  | 'complaint_follow_up'
  | 'service_quality_complaint'
  | 'document_or_certification_request';

export type SpecialIntentType =
  | 'multi_issue_case'
  | 'general_complaint'
  | 'unclear_issue';

export type OutOfScopeIntentType = 'unsupported_request';

// Union of all supported intent types — use this for intent_type fields.
export type SupportedIntentType =
  | InformationalIntentType
  | OperationalIntentType
  | SpecialIntentType
  | OutOfScopeIntentType;

// ---------------------------------------------------------------------------
// Card-block-eligible operational intents (drives Policy Agent FR-POL-05)
// ---------------------------------------------------------------------------

export const CARD_BLOCK_ELIGIBLE_INTENTS: ReadonlySet<SupportedIntentType> =
  new Set<SupportedIntentType>([
    'lost_or_stolen_card',
    'unauthorized_transaction',
  ]);

// ---------------------------------------------------------------------------
// Entities extracted from the user message
// ---------------------------------------------------------------------------

export interface IntentEntities {
  /** Financial product involved (e.g. "savings account", "credit card") */
  product?: string | null;
  /** Monetary value extracted from the message */
  amount?: number | null;
  /** Date or time reference mentioned (free text, e.g. "last Tuesday") */
  date_reference?: string | null;
  /** Channel referenced (e.g. "mobile app", "ATM") */
  channel?: string | null;
  /** Transaction ID, ticket number, or any reference number */
  reference_number?: string | null;
  /** Urgency language cue (e.g. "urgent", "emergency") */
  urgency_cue?: string | null;
  /** Action the customer says they or a third party performed */
  reported_action?: string | null;
}

// ---------------------------------------------------------------------------
// Behavioural flags set by the Intent Agent
// ---------------------------------------------------------------------------

export interface IntentFlags {
  /** confidence < 0.60 — enter clarification loop */
  ambiguous: boolean;
  /** message maps to 2+ operational intents */
  multi_issue: boolean;
  /** message contains both informational and operational intents */
  hybrid: boolean;
  /** new concern differs from the active case intent */
  topic_switch: boolean;
  /** prompt injection or data exfiltration attempt detected */
  malicious_input: boolean;
}

// ---------------------------------------------------------------------------
// Per-issue component (used when multi_issue = true or hybrid = true)
// Each decomposed concern gets its own component.
// ---------------------------------------------------------------------------

export interface IssueComponent {
  intent_type: SupportedIntentType;
  intent_group: IntentGroup;
  /** 0–1 confidence for this component */
  confidence: number;
  entities: IntentEntities;
  /** One-sentence human-readable summary of this component */
  summary: string;
}

// ---------------------------------------------------------------------------
// How the new message relates to the existing active case (if any)
// ---------------------------------------------------------------------------

export type CaseConsistency =
  | 'same_case'         // new message is about the existing open case
  | 'possible_topic_switch' // might be a new concern; needs validation
  | 'new_issue'         // clearly unrelated to the active case
  | 'no_active_case';   // no case is currently open for this session

// ---------------------------------------------------------------------------
// IntentResult — primary output of the Intent Agent
// ---------------------------------------------------------------------------

export interface IntentResult {
  /** Primary classified intent */
  intent_type: SupportedIntentType;
  /** Top-level routing group */
  intent_group: IntentGroup;
  /** Classification confidence 0–1 */
  confidence: number;
  /** Any additional intents detected beyond the primary */
  secondary_intents: SupportedIntentType[];
  /** Structured entities extracted from the message */
  entities: IntentEntities;
  /** Routing and safety flags */
  flags: IntentFlags;
  /**
   * Decomposed issue components.
   * Populated when multi_issue = true or hybrid = true.
   * Single-issue messages will have exactly one component.
   */
  issue_components: IssueComponent[];
  /**
   * Intent candidates surfaced to the user during a clarification loop.
   * Empty unless flags.ambiguous = true.
   */
  candidate_intents_for_clarification: SupportedIntentType[];
  /** Relationship between this message and the active case */
  consistency_with_active_case: CaseConsistency;
  /**
   * Short human-readable strings explaining the classification.
   * Used for audit trails and debugging — never exposed to users.
   */
  evidence: string[];
  /** Preserved raw LLM output for debugging. Not used in business logic. */
  raw_llm_output?: unknown;
}