// ─────────────────────────────────────────────────────────────────────────────
// Triage Agent — Hybrid (LLM signal extraction + deterministic matrix)
//
// P1 triggers (hard overrides — only two):
//   1. active_fraud_signal   — unauthorized transaction, stolen card
//   2. account_compromise_signal — third party explicitly accessed account
//
// Everything else goes through the matrix only. No access_to_funds_blocked
// override. No urgency language override for account_access_issue.
//
// Matrix: importance × urgency → priority
//   high   + low    → P2
//   high   + medium → P1
//   medium + low    → P3
//   medium + medium → P2
//   medium + high   → P1
//
// Key baselines:
//   unauthorized_transaction:   high + high   → P1 (+ fraud override)
//   lost_or_stolen_card:        high + high   → P1 (+ fraud override)
//   account_access_issue:       high + low    → P2
//   account_restriction_issue:  high + low    → P2
//   failed_or_delayed_transfer: medium + low  → P3
//   refund_or_reversal_issue:   medium + low  → P3
//   billing_or_fee_dispute:     medium + low  → P3
// ─────────────────────────────────────────────────────────────────────────────

import type { IntentResult, OperationalIntentType } from '../contracts/intent.contract';
import type {
  TriageSignals, TriageResult, Importance, Urgency,
  Priority, RecommendedPath, TriageOverrideReason,
} from '../contracts/triage.contract';
import type { EmotionResult }   from '../contracts/emotion.contract';

import { EMOTION_TRIAGE_INTENSITY_THRESHOLD } from '../contracts/emotion.contract';
import { callGemini }           from '../llm/gemini.client';
import { extractJSON }          from '../utils/json-extract';
import { buildTriageMessages }  from '../llm/prompts/triage.prompt';
import { env }                  from '../config/env';

// ---------------------------------------------------------------------------
// Intent sets for rule-based signal extraction
//
// Only intents where the signal is unconditionally true belong here.
// Context-dependent signals are handled by the LLM.
// ---------------------------------------------------------------------------

// Fraud is always true for these — no message context needed
const FRAUD_INTENTS = new Set<OperationalIntentType>([
  'unauthorized_transaction',
  'lost_or_stolen_card',
]);

// Unauthorized transaction always implies third-party account access
const ACCOUNT_COMPROMISE_INTENTS = new Set<OperationalIntentType>([
  'unauthorized_transaction',
]);

// NO_FUNDS_ACCESS_INTENTS intentionally empty:
// access_to_funds_blocked override has been removed.
// No intent auto-escalates to P1 via funds-access signal.
// P1 is reached only via fraud or account compromise overrides,
// or via the matrix (high importance + high urgency).
const NO_FUNDS_ACCESS_INTENTS = new Set<OperationalIntentType>([]);

// ---------------------------------------------------------------------------
// Intent baselines
// ---------------------------------------------------------------------------

interface BaselineSignal { importance: Importance; urgency: Urgency; }

const INTENT_BASELINE: Partial<Record<OperationalIntentType, BaselineSignal>> = {
  // P1 via fraud override + matrix
  unauthorized_transaction:          { importance: 'high',   urgency: 'high' },
  lost_or_stolen_card:               { importance: 'high',   urgency: 'high' },

  // P2 via matrix (high + low)
  // urgency stays low even when urgency language is present —
  // see computeUrgency guard below
  account_access_issue:              { importance: 'high',   urgency: 'low'  },
  account_restriction_issue:         { importance: 'high',   urgency: 'low'  },

  // P3 via matrix (medium + low)
  // Can reach P2 if LLM detects urgency_language=high → upgrades to medium
  failed_or_delayed_transfer:        { importance: 'medium', urgency: 'low'  },
  refund_or_reversal_issue:          { importance: 'medium', urgency: 'low'  },
  billing_or_fee_dispute:            { importance: 'medium', urgency: 'low'  },
  complaint_follow_up:               { importance: 'medium', urgency: 'low'  },

  // P3 via matrix (low + low)
  service_quality_complaint:         { importance: 'low',    urgency: 'low'  },
  document_or_certification_request: { importance: 'low',    urgency: 'low'  },
};

// ---------------------------------------------------------------------------
// Priority matrix  importance × urgency → priority
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
// Rule-based signal extraction (fallback when LLM fails)
// ---------------------------------------------------------------------------

function extractSignalsRuleBased(
  intentResult: IntentResult,
  evidence: string[]
): TriageSignals {
  const intentType = intentResult.intent_type as OperationalIntentType;
  const entities   = intentResult.entities;

  const active_fraud_signal       = FRAUD_INTENTS.has(intentType);
  const account_compromise_signal = ACCOUNT_COMPROMISE_INTENTS.has(intentType);
  const access_to_funds_blocked   = false; // override removed — never set by rule-based

  const HIGH_VALUE_THRESHOLD = 10_000;
  const high_value_amount    = typeof entities.amount === 'number' &&
                               entities.amount >= HIGH_VALUE_THRESHOLD;
  const multiple_transactions = false;
  const aging_signal          = entities.date_reference !== null ||
                                (typeof entities.urgency_cue === 'string' &&
                                 entities.urgency_cue.length > 0);

  const urgency_language: 'low' | 'medium' | 'high' =
    entities.urgency_cue ? 'high' : 'low';

  const financial_impact: 'low' | 'medium' | 'high' =
    high_value_amount
      ? 'high'
      : (typeof entities.amount === 'number' && entities.amount > 0 ? 'medium' : 'low');

  if (active_fraud_signal)       evidence.push(`[rule] Fraud signal: ${intentType}`);
  if (account_compromise_signal) evidence.push(`[rule] Account compromise: ${intentType}`);
  if (high_value_amount)         evidence.push(`[rule] High-value amount: ${entities.amount}`);
  if (aging_signal)              evidence.push(`[rule] Aging signal detected`);

  return {
    active_fraud_signal,
    account_compromise_signal,
    access_to_funds_blocked,
    multiple_transactions,
    high_value_amount,
    aging_signal,
    urgency_language,
    financial_impact,
    evidence,
  };
}

// ---------------------------------------------------------------------------
// LLM signal extraction
// ---------------------------------------------------------------------------

async function extractSignalsLLM(
  userMessage: string,
  intentResult: IntentResult,
  evidence: string[]
): Promise<TriageSignals | null> {
  try {
    const messages = buildTriageMessages(userMessage, intentResult);

    const llmResponse = await callGemini({
      messages,
      model:       env.TRIAGE_MODEL,
      temperature: 0.1,
      maxTokens:   1024,
    });

    const parsed = extractJSON(llmResponse.text);
    if (!parsed) {
      console.warn('[TriageAgent] Unparseable LLM signal output');
      return null;
    }

    const safeBool  = (v: unknown): boolean =>
      typeof v === 'boolean' ? v : false;

    const safeLevel = (
      v: unknown,
      fallback: 'low' | 'medium' | 'high'
    ): 'low' | 'medium' | 'high' => {
      if (v === 'high' || v === 'medium' || v === 'low') return v;
      return fallback;
    };

    const intentType = intentResult.intent_type as OperationalIntentType;

    const signals: TriageSignals = {
      active_fraud_signal:       safeBool(parsed['active_fraud_signal']),
      account_compromise_signal: safeBool(parsed['account_compromise_signal']),
      access_to_funds_blocked:   false, // override removed — always false
      multiple_transactions:     safeBool(parsed['multiple_transactions']),
      high_value_amount:         safeBool(parsed['high_value_amount']),
      aging_signal:              safeBool(parsed['aging_signal']),
      urgency_language:          safeLevel(parsed['urgency_language'], 'low'),
      financial_impact:          safeLevel(parsed['financial_impact'],  'low'),
      evidence: Array.isArray(parsed['evidence'])
        ? parsed['evidence']
            .filter((e): e is string => typeof e === 'string')
            .map(e => `[llm] ${e}`)
        : ['[llm] Signal extraction complete'],
      raw_llm_output: { model: llmResponse.model_used, usage: llmResponse.usage },
    };

    // Safety guard: active_fraud_signal must not be set for non-fraud intents
    if (signals.active_fraud_signal && !FRAUD_INTENTS.has(intentType)) {
      signals.active_fraud_signal = false;
      signals.evidence.push('[guard] active_fraud_signal cleared: not a fraud intent');
    }

    // Safety guard: account_compromise_signal must not be set for
    // restriction, billing, refund, or transfer intents
    if (
      signals.account_compromise_signal &&
      (intentType === 'account_restriction_issue' ||
       intentType === 'account_access_issue'       ||
       intentType === 'billing_or_fee_dispute'     ||
       intentType === 'refund_or_reversal_issue'   ||
       intentType === 'failed_or_delayed_transfer')
    ) {
      signals.account_compromise_signal = false;
      signals.evidence.push('[guard] account_compromise_signal cleared: not applicable to intent');
    }

    evidence.push(...signals.evidence);
    return signals;
  } catch (err) {
    console.warn(
      '[TriageAgent] LLM signal extraction failed',
      err instanceof Error ? err.message : err
    );
    return null;
  }
}

// ---------------------------------------------------------------------------
// Deterministic matrix computation
// ---------------------------------------------------------------------------

function computeImportance(
  signals: TriageSignals,
  intentType: OperationalIntentType,
  evidence: string[]
): Importance {
  let importance: Importance = INTENT_BASELINE[intentType]?.importance ?? 'low';

  // Only fraud and compromise upgrade importance
  if (signals.active_fraud_signal || signals.account_compromise_signal) {
    if (importance !== 'high') evidence.push('Importance upgraded to high: fraud/compromise signal');
    importance = 'high';
  }

  if (signals.high_value_amount && importance === 'low') {
    importance = 'medium';
    evidence.push('Importance upgraded to medium: high-value amount');
  }

  if (signals.multiple_transactions && importance !== 'high') {
    importance = 'high';
    evidence.push('Importance upgraded to high: multiple transactions');
  }

  evidence.push(`Final importance: ${importance}`);
  return importance;
}

function computeUrgency(
  signals: TriageSignals,
  intentType: OperationalIntentType,
  evidence: string[]
): Urgency {
  let urgency: Urgency = INTENT_BASELINE[intentType]?.urgency ?? 'low';

  // Only active fraud upgrades urgency — no other signal can change urgency.
  // Customer urgency language ("urgently", "today", "emergency") and aging
  // signals are explicitly ignored — they are not reliable priority signals.
  if (signals.active_fraud_signal) {
    if (urgency !== 'high') evidence.push('Urgency upgraded to high: fraud signal');
    urgency = 'high';
  }

  evidence.push(`Final urgency: ${urgency}`);
  return urgency;
}

// ---------------------------------------------------------------------------
// P1 hard overrides — fraud and compromise only
// ---------------------------------------------------------------------------

function applyOverrides(
  matrixPriority: Priority,
  signals: TriageSignals,
  evidence: string[]
): { priority: Priority; overrideReason: TriageOverrideReason } {

  if (signals.active_fraud_signal) {
    evidence.push('P1 override: active fraud signal');
    return { priority: 'P1', overrideReason: 'fraud_override' };
  }

  if (signals.account_compromise_signal) {
    evidence.push('P1 override: account compromise signal');
    return { priority: 'P1', overrideReason: 'account_compromise_override' };
  }

  evidence.push(`No override — matrix priority ${matrixPriority} stands`);
  return { priority: matrixPriority, overrideReason: 'none' };
}

// ---------------------------------------------------------------------------
// Emotion soft-signal
//
// Only anxious emotion at high intensity qualifies for a one-step urgency
// upgrade (low → medium). No other emotion label changes urgency. This is a
// soft signal: it cannot push urgency above medium and it never overrides the
// deterministic fraud / compromise P1 overrides.
// ---------------------------------------------------------------------------

function applyEmotionSoftSignal(
  urgency:       Urgency,
  emotionResult: EmotionResult | undefined,
  evidence:      string[]
): Urgency {
  if (!emotionResult) return urgency;
  if (emotionResult.label !== 'anxious') return urgency;
  if (emotionResult.intensity < EMOTION_TRIAGE_INTENSITY_THRESHOLD) return urgency;
  if (urgency !== 'low') return urgency;

  evidence.push('[emotion] high-distress emotion signal: upgraded urgency low → medium');
  return 'medium';
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

// Synchronous triage — rule-based only, used in tests and sync contexts
export function triageIntent(
  intentResult:  IntentResult,
  emotionResult?: EmotionResult
): TriageResult {
  const intentType = intentResult.intent_type as OperationalIntentType;
  const evidence: string[] = [`[sync] Triaging: ${intentType}`];

  const signals    = extractSignalsRuleBased(intentResult, evidence);
  const importance = computeImportance(signals, intentType, evidence);
  const baseUrgency = computeUrgency(signals, intentType, evidence);
  const urgency     = applyEmotionSoftSignal(baseUrgency, emotionResult, evidence);
  const matrix      = PRIORITY_MATRIX[importance][urgency];
  const { priority, overrideReason } = applyOverrides(matrix, signals, evidence);

  return {
    importance,
    urgency,
    priority,
    recommended_path: PATH_BY_PRIORITY[priority],
    override_reason:  overrideReason,
    evidence,
  };
}

// Async triage — LLM signal extraction + deterministic matrix
export async function triageIntentAsync(
  intentResult:  IntentResult,
  userMessage:   string,
  emotionResult?: EmotionResult
): Promise<TriageResult> {
  const intentType = intentResult.intent_type as OperationalIntentType;
  const evidence: string[] = [`Triaging: ${intentType}`];

  let signals: TriageSignals | null = null;

  // failed_or_delayed_transfer: rule-based only
  // LLM adds no signal value for pure delay cases
  if (intentType === 'failed_or_delayed_transfer') {
    evidence.push('[triage] Rule-based only for failed_or_delayed_transfer');
    signals = extractSignalsRuleBased(intentResult, evidence);
  } else if (env.NODE_ENV !== 'test') {
    signals = await extractSignalsLLM(userMessage, intentResult, evidence);
  }

  if (!signals) {
    evidence.push('[fallback] Using rule-based signal extraction');
    signals = extractSignalsRuleBased(intentResult, evidence);
  }

  const importance  = computeImportance(signals, intentType, evidence);
  const baseUrgency = computeUrgency(signals, intentType, evidence);
  const urgency     = applyEmotionSoftSignal(baseUrgency, emotionResult, evidence);
  const matrix      = PRIORITY_MATRIX[importance][urgency];
  const { priority, overrideReason } = applyOverrides(matrix, signals, evidence);

  return {
    importance,
    urgency,
    priority,
    recommended_path: PATH_BY_PRIORITY[priority],
    override_reason:  overrideReason,
    evidence,
  };
}