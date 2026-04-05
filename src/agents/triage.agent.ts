// ─────────────────────────────────────────────────────────────────────────────
// Triage Agent — Deterministic Rule-Based Implementation (Phase 2, Slice 1)
// Scope: single operational issue only.
// Multi-issue and hybrid triage are out of scope for this slice.
//
// Execution order:
//   1. Extract triage signals from IntentResult
//   2. Apply importance rules
//   3. Apply urgency rules
//   4. Run priority matrix (Importance × Urgency)
//   5. Apply P1 override rules (unconditional)
//   6. Derive recommended_path from final priority
//   7. Return TriageResult
//
// The LLM hook point for signal extraction is marked TODO: LLM_HOOK.
// ─────────────────────────────────────────────────────────────────────────────

import type { IntentResult, OperationalIntentType } from '../contracts/intent.contract';
import type {
  TriageSignals,
  TriageResult,
  Importance,
  Urgency,
  Priority,
  RecommendedPath,
  TriageOverrideReason,
} from '../contracts/triage.contract';

// ---------------------------------------------------------------------------
// Intents that carry an inherent fraud / high-risk signal
// ---------------------------------------------------------------------------

const FRAUD_INTENTS = new Set<OperationalIntentType>([
  'unauthorized_transaction',
  'lost_or_stolen_card',
]);

const NO_FUNDS_ACCESS_INTENTS = new Set<OperationalIntentType>([
  'account_access_issue',
  'account_restriction_issue',
]);

const ACCOUNT_COMPROMISE_INTENTS = new Set<OperationalIntentType>([
  'unauthorized_transaction',
  'account_restriction_issue',
]);

// ---------------------------------------------------------------------------
// Intents mapped to their baseline importance and urgency
// Used in Step 2 and Step 3 before context upgrades are applied.
// ---------------------------------------------------------------------------

interface BaselineSignal {
  importance: Importance;
  urgency: Urgency;
}

const INTENT_BASELINE: Partial<Record<OperationalIntentType, BaselineSignal>> = {
  unauthorized_transaction:         { importance: 'high',   urgency: 'high'   },
  lost_or_stolen_card:              { importance: 'high',   urgency: 'high'   },
  failed_or_delayed_transfer:       { importance: 'medium', urgency: 'low'    },
  refund_or_reversal_issue:         { importance: 'medium', urgency: 'low'    },
  account_access_issue:             { importance: 'high',   urgency: 'medium' },
  account_restriction_issue:        { importance: 'high',   urgency: 'medium' },
  billing_or_fee_dispute:           { importance: 'medium', urgency: 'low'    },
  complaint_follow_up:              { importance: 'medium', urgency: 'low'    },
  service_quality_complaint:        { importance: 'low',    urgency: 'low'    },
  document_or_certification_request:{ importance: 'low',    urgency: 'low'    },
};

// ---------------------------------------------------------------------------
// Priority matrix: Importance × Urgency → Priority
// SRS §3.2.2 Priority Matrix
//
//              Urgency
//              low    medium  high
// Importance
//   low        P4     P3      P2
//   medium     P3     P2      P1
//   high       P2     P1      P1
//
// Note: P4 is mapped to P3 here because tracked operational cases
// always produce at minimum a P3 ticket (SRS CON-05).
// ---------------------------------------------------------------------------

const PRIORITY_MATRIX: Record<Importance, Record<Urgency, Priority>> = {
  low:    { low: 'P3', medium: 'P3', high: 'P2' },
  medium: { low: 'P3', medium: 'P2', high: 'P1' },
  high:   { low: 'P2', medium: 'P1', high: 'P1' },
};

const PATH_BY_PRIORITY: Record<Priority, RecommendedPath> = {
  P1: 'live_escalation',
  P2: 'urgent_ticket',
  P3: 'standard_ticket',
  P4: 'self_service',
};

// ---------------------------------------------------------------------------
// Step 1: Extract triage signals from IntentResult
//
// TODO: LLM_HOOK — Replace this function with an LLM call that receives
// the user message + IntentResult and returns a structured TriageSignals
// JSON. Run the returned signals through the same priority matrix and
// override rules below. The matrix and overrides are never delegated to
// the LLM.
// ---------------------------------------------------------------------------

function extractSignals(intentResult: IntentResult): { signals: TriageSignals; evidence: string[] } {
  const evidence: string[] = [];
  const intentType = intentResult.intent_type as OperationalIntentType;
  const entities = intentResult.entities;

  const active_fraud_signal = FRAUD_INTENTS.has(intentType);
  const account_compromise_signal = ACCOUNT_COMPROMISE_INTENTS.has(intentType);
  const access_to_funds_blocked = NO_FUNDS_ACCESS_INTENTS.has(intentType);

  // Amount threshold: treat amounts above this as high-value (configurable)
  const HIGH_VALUE_THRESHOLD = 10_000;
  const high_value_amount =
    typeof entities.amount === 'number' && entities.amount >= HIGH_VALUE_THRESHOLD;

  const multiple_transactions = false; // Rule-based cannot detect this; LLM hook needed

  // Aging signal: inferred from date reference or urgency cue
  const aging_signal =
    entities.date_reference !== null ||
    (typeof entities.urgency_cue === 'string' && entities.urgency_cue.length > 0);

  // Urgency language
  const urgencyLanguage: 'low' | 'medium' | 'high' =
    entities.urgency_cue !== null ? 'high' : 'low';

  // Financial impact from amount
  const financialImpact: 'low' | 'medium' | 'high' =
    high_value_amount ? 'high'
    : typeof entities.amount === 'number' && entities.amount > 0 ? 'medium'
    : 'low';

  if (active_fraud_signal)        evidence.push(`Fraud signal: intent_type=${intentType}`);
  if (account_compromise_signal)  evidence.push(`Account compromise signal: intent_type=${intentType}`);
  if (access_to_funds_blocked)    evidence.push(`No funds access signal: intent_type=${intentType}`);
  if (high_value_amount)          evidence.push(`High-value amount: ${entities.amount}`);
  if (aging_signal)               evidence.push(`Aging signal: date_reference="${entities.date_reference}" urgency_cue="${entities.urgency_cue}"`);
  if (urgencyLanguage === 'high') evidence.push(`Urgency cue present: "${entities.urgency_cue}"`);

  const signals: TriageSignals = {
    active_fraud_signal,
    account_compromise_signal,
    access_to_funds_blocked,
    multiple_transactions,
    high_value_amount,
    aging_signal,
    urgency_language: urgencyLanguage,
    financial_impact: financialImpact,
    evidence,
  };

  return { signals, evidence };
}

// ---------------------------------------------------------------------------
// Step 2: Compute importance from signals and intent baseline
// ---------------------------------------------------------------------------

function computeImportance(
  signals: TriageSignals,
  intentType: OperationalIntentType,
  evidence: string[]
): Importance {
  const baseline = INTENT_BASELINE[intentType];
  let importance: Importance = baseline?.importance ?? 'low';

  // Context upgrades — apply the highest applicable level
  if (signals.active_fraud_signal || signals.account_compromise_signal) {
    if (importance !== 'high') {
      evidence.push(`Importance upgraded to high: fraud/compromise signal`);
    }
    importance = 'high';
  }

  if (signals.access_to_funds_blocked) {
    if (importance !== 'high') {
      evidence.push(`Importance upgraded to high: no access to funds`);
    }
    importance = 'high';
  }

  if (signals.high_value_amount && importance === 'low') {
    importance = 'medium';
    evidence.push(`Importance upgraded to medium: high-value amount`);
  }

  if (signals.multiple_transactions && importance !== 'high') {
    importance = 'high';
    evidence.push(`Importance upgraded to high: multiple transactions affected`);
  }

  evidence.push(`Final importance: ${importance} (baseline from ${intentType})`);
  return importance;
}

// ---------------------------------------------------------------------------
// Step 3: Compute urgency from signals and intent baseline
// ---------------------------------------------------------------------------

function computeUrgency(
  signals: TriageSignals,
  intentType: OperationalIntentType,
  evidence: string[]
): Urgency {
  const baseline = INTENT_BASELINE[intentType];
  let urgency: Urgency = baseline?.urgency ?? 'low';

  if (signals.active_fraud_signal || signals.access_to_funds_blocked) {
    if (urgency !== 'high') {
      evidence.push(`Urgency upgraded to high: fraud or funds access blocked`);
    }
    urgency = 'high';
  }

  if (signals.urgency_language === 'high' && urgency === 'low') {
    urgency = 'medium';
    evidence.push(`Urgency upgraded to medium: urgency language detected`);
  }

  if (signals.aging_signal && urgency === 'low') {
    urgency = 'medium';
    evidence.push(`Urgency upgraded to medium: aging or date reference detected`);
  }

  evidence.push(`Final urgency: ${urgency} (baseline from ${intentType})`);
  return urgency;
}

// ---------------------------------------------------------------------------
// Step 4: Priority matrix lookup
// ---------------------------------------------------------------------------

function applyPriorityMatrix(
  importance: Importance,
  urgency: Urgency,
  evidence: string[]
): Priority {
  const priority = PRIORITY_MATRIX[importance][urgency];
  evidence.push(`Priority matrix (${importance} × ${urgency}) → ${priority}`);
  return priority;
}

// ---------------------------------------------------------------------------
// Step 5: P1 override rules (unconditional — SRS FR-TRI-09)
// These fire regardless of the matrix result.
// ---------------------------------------------------------------------------

function applyOverrides(
  matrixPriority: Priority,
  signals: TriageSignals,
  evidence: string[]
): { priority: Priority; overrideReason: TriageOverrideReason } {
  if (signals.active_fraud_signal) {
    evidence.push(`P1 override applied: fraud_override (active_fraud_signal=true)`);
    return { priority: 'P1', overrideReason: 'fraud_override' };
  }

  if (signals.account_compromise_signal) {
    evidence.push(`P1 override applied: account_compromise_override`);
    return { priority: 'P1', overrideReason: 'account_compromise_override' };
  }

  if (signals.access_to_funds_blocked) {
    evidence.push(`P1 override applied: no_access_to_funds_override`);
    return { priority: 'P1', overrideReason: 'no_access_to_funds_override' };
  }

  evidence.push(`No override applied; matrix priority ${matrixPriority} stands`);
  return { priority: matrixPriority, overrideReason: 'none' };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Computes a deterministic TriageResult for a single operational concern.
 *
 * Must only be called when intent_group = 'operational'.
 * Informational, clarification, and refusal branches bypass Triage.
 */
export function triageIntent(intentResult: IntentResult): TriageResult {
  const intentType = intentResult.intent_type as OperationalIntentType;
  const evidence: string[] = [];

  evidence.push(`Triaging intent: ${intentType}`);

  // Step 1: Extract signals
  const { signals, evidence: signalEvidence } = extractSignals(intentResult);
  evidence.push(...signalEvidence);

  // Step 2: Importance
  const importance = computeImportance(signals, intentType, evidence);

  // Step 3: Urgency
  const urgency = computeUrgency(signals, intentType, evidence);

  // Step 4: Matrix
  const matrixPriority = applyPriorityMatrix(importance, urgency, evidence);

  // Step 5: Overrides
  const { priority, overrideReason } = applyOverrides(matrixPriority, signals, evidence);

  // Step 6: Path
  const recommendedPath: RecommendedPath = PATH_BY_PRIORITY[priority];
  evidence.push(`Recommended path: ${recommendedPath}`);

  return {
    importance,
    urgency,
    priority,
    recommended_path: recommendedPath,
    override_reason: overrideReason,
    evidence,
  };
}