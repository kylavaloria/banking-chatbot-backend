// ─────────────────────────────────────────────────────────────────────────────
// Triage Agent — Slice 4: Hybrid (LLM signal extraction + deterministic matrix)
//
// Execution order:
//   1. Try LLM signal extraction (Groq 8b)
//   2. On failure, use rule-based signal extraction
//   3. Deterministic matrix + P1 overrides (always authoritative)
// ─────────────────────────────────────────────────────────────────────────────

import type { IntentResult, OperationalIntentType } from '../contracts/intent.contract';
import type {
  TriageSignals, TriageResult, Importance, Urgency,
  Priority, RecommendedPath, TriageOverrideReason,
} from '../contracts/triage.contract';

import { callGroq }             from '../llm/groq.client';
import { extractJSON }          from '../utils/json-extract';
import { buildTriageMessages }  from '../llm/prompts/triage.prompt';
import { env }                  from '../config/env';

// ---------------------------------------------------------------------------
// Baseline signals per intent (rule-based fallback data)
// ---------------------------------------------------------------------------

const FRAUD_INTENTS           = new Set<OperationalIntentType>(['unauthorized_transaction', 'lost_or_stolen_card']);
const NO_FUNDS_ACCESS_INTENTS = new Set<OperationalIntentType>(['account_access_issue', 'account_restriction_issue']);
const ACCOUNT_COMPROMISE_INTENTS = new Set<OperationalIntentType>(['unauthorized_transaction', 'account_restriction_issue']);

interface BaselineSignal { importance: Importance; urgency: Urgency; }

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
// Priority matrix
// ---------------------------------------------------------------------------

const PRIORITY_MATRIX: Record<Importance, Record<Urgency, Priority>> = {
  low:    { low: 'P3', medium: 'P3', high: 'P2' },
  medium: { low: 'P3', medium: 'P2', high: 'P1' },
  high:   { low: 'P2', medium: 'P1', high: 'P1' },
};

const PATH_BY_PRIORITY: Record<Priority, RecommendedPath> = {
  P1: 'live_escalation', P2: 'urgent_ticket',
  P3: 'standard_ticket', P4: 'self_service',
};

// ---------------------------------------------------------------------------
// Rule-based signal extraction (fallback)
// ---------------------------------------------------------------------------

function extractSignalsRuleBased(
  intentResult: IntentResult,
  evidence: string[]
): TriageSignals {
  const intentType = intentResult.intent_type as OperationalIntentType;
  const entities   = intentResult.entities;

  const active_fraud_signal      = FRAUD_INTENTS.has(intentType);
  const account_compromise_signal= ACCOUNT_COMPROMISE_INTENTS.has(intentType);
  const access_to_funds_blocked  = NO_FUNDS_ACCESS_INTENTS.has(intentType);
  const HIGH_VALUE_THRESHOLD     = 10_000;
  const high_value_amount        = typeof entities.amount === 'number' && entities.amount >= HIGH_VALUE_THRESHOLD;
  const multiple_transactions    = false;
  const aging_signal             = entities.date_reference !== null || (typeof entities.urgency_cue === 'string' && entities.urgency_cue.length > 0);
  const urgency_language: 'low' | 'medium' | 'high' = entities.urgency_cue ? 'high' : 'low';
  const financial_impact: 'low' | 'medium' | 'high' = high_value_amount ? 'high' : (typeof entities.amount === 'number' && entities.amount > 0 ? 'medium' : 'low');

  if (active_fraud_signal)        evidence.push(`[rule] Fraud signal: ${intentType}`);
  if (account_compromise_signal)  evidence.push(`[rule] Account compromise: ${intentType}`);
  if (access_to_funds_blocked)    evidence.push(`[rule] No funds access: ${intentType}`);
  if (high_value_amount)          evidence.push(`[rule] High-value amount: ${entities.amount}`);
  if (aging_signal)               evidence.push(`[rule] Aging signal detected`);

  return {
    active_fraud_signal, account_compromise_signal, access_to_funds_blocked,
    multiple_transactions, high_value_amount, aging_signal,
    urgency_language, financial_impact, evidence,
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

    const llmResponse = await callGroq({
      messages,
      model:       env.TRIAGE_MODEL,
      temperature: 0.1,
      maxTokens:   512,
    });

    const parsed = extractJSON(llmResponse.text);
    if (!parsed) {
      console.warn('[TriageAgent] Unparseable LLM signal output');
      return null;
    }

    // Validate and normalize signal fields
    const safeBool = (v: unknown) => typeof v === 'boolean' ? v : false;
    const safeLevel = (v: unknown, fallback: 'low' | 'medium' | 'high'): 'low' | 'medium' | 'high' => {
      if (v === 'high' || v === 'medium' || v === 'low') return v;
      return fallback;
    };

    const signals: TriageSignals = {
      active_fraud_signal:       safeBool(parsed['active_fraud_signal']),
      account_compromise_signal: safeBool(parsed['account_compromise_signal']),
      access_to_funds_blocked:   safeBool(parsed['access_to_funds_blocked']),
      multiple_transactions:     safeBool(parsed['multiple_transactions']),
      high_value_amount:         safeBool(parsed['high_value_amount']),
      aging_signal:              safeBool(parsed['aging_signal']),
      urgency_language:          safeLevel(parsed['urgency_language'], 'low'),
      financial_impact:          safeLevel(parsed['financial_impact'], 'low'),
      evidence: Array.isArray(parsed['evidence'])
        ? parsed['evidence'].filter((e): e is string => typeof e === 'string').map(e => `[llm] ${e}`)
        : ['[llm] Signal extraction complete'],
      raw_llm_output: { model: llmResponse.model_used, usage: llmResponse.usage },
    };

    evidence.push(...signals.evidence);
    return signals;
  } catch (err) {
    console.warn('[TriageAgent] LLM signal extraction failed', err instanceof Error ? err.message : err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Deterministic matrix + overrides (always authoritative)
// ---------------------------------------------------------------------------

function computeImportance(signals: TriageSignals, intentType: OperationalIntentType, evidence: string[]): Importance {
  let importance: Importance = INTENT_BASELINE[intentType]?.importance ?? 'low';
  if (signals.active_fraud_signal || signals.account_compromise_signal || signals.access_to_funds_blocked) {
    if (importance !== 'high') evidence.push(`Importance upgraded to high: critical signal`);
    importance = 'high';
  }
  if (signals.high_value_amount && importance === 'low') { importance = 'medium'; evidence.push(`Importance upgraded to medium: high-value`); }
  if (signals.multiple_transactions && importance !== 'high') { importance = 'high'; evidence.push(`Importance upgraded to high: multiple transactions`); }
  evidence.push(`Final importance: ${importance}`);
  return importance;
}

function computeUrgency(signals: TriageSignals, intentType: OperationalIntentType, evidence: string[]): Urgency {
  let urgency: Urgency = INTENT_BASELINE[intentType]?.urgency ?? 'low';
  if (signals.active_fraud_signal || signals.access_to_funds_blocked) { if (urgency !== 'high') evidence.push(`Urgency upgraded to high: fraud/funds`); urgency = 'high'; }
  if (signals.urgency_language === 'high' && urgency === 'low') { urgency = 'medium'; evidence.push(`Urgency upgraded to medium: urgency language`); }
  if (signals.aging_signal && urgency === 'low') { urgency = 'medium'; evidence.push(`Urgency upgraded to medium: aging`); }
  evidence.push(`Final urgency: ${urgency}`);
  return urgency;
}

function applyOverrides(
  matrixPriority: Priority,
  signals: TriageSignals,
  evidence: string[]
): { priority: Priority; overrideReason: TriageOverrideReason } {
  if (signals.active_fraud_signal)        { evidence.push('P1 override: fraud');           return { priority: 'P1', overrideReason: 'fraud_override' }; }
  if (signals.account_compromise_signal)  { evidence.push('P1 override: compromise');      return { priority: 'P1', overrideReason: 'account_compromise_override' }; }
  if (signals.access_to_funds_blocked)    { evidence.push('P1 override: no funds access'); return { priority: 'P1', overrideReason: 'no_access_to_funds_override' }; }
  evidence.push(`No override; matrix priority ${matrixPriority} stands`);
  return { priority: matrixPriority, overrideReason: 'none' };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------


export function triageIntent(intentResult: IntentResult): TriageResult {
  const intentType = intentResult.intent_type as OperationalIntentType;
  const evidence: string[] = [`[sync] Triaging: ${intentType}`];
  const signals    = extractSignalsRuleBased(intentResult, evidence);
  const importance = computeImportance(signals, intentType, evidence);
  const urgency    = computeUrgency(signals, intentType, evidence);
  const matrix     = PRIORITY_MATRIX[importance][urgency];
  const { priority, overrideReason } = applyOverrides(matrix, signals, evidence);
  return {
    importance, urgency, priority,
    recommended_path: PATH_BY_PRIORITY[priority],
    override_reason:  overrideReason,
    evidence,
  };
}

export async function triageIntentAsync(
  intentResult: IntentResult,
  userMessage:  string
): Promise<TriageResult> {
  const intentType = intentResult.intent_type as OperationalIntentType;
  const evidence: string[] = [`Triaging: ${intentType}`];

  let signals: TriageSignals | null = null;
  if (env.NODE_ENV !== 'test') {
    signals = await extractSignalsLLM(userMessage, intentResult, evidence);
  }

  if (!signals) {
    evidence.push('[fallback] Using rule-based signal extraction');
    signals = extractSignalsRuleBased(intentResult, evidence);
  }

  const importance = computeImportance(signals, intentType, evidence);
  const urgency    = computeUrgency(signals, intentType, evidence);
  const matrix     = PRIORITY_MATRIX[importance][urgency];
  const { priority, overrideReason } = applyOverrides(matrix, signals, evidence);

  return {
    importance, urgency, priority,
    recommended_path: PATH_BY_PRIORITY[priority],
    override_reason:  overrideReason,
    evidence,
  };
}