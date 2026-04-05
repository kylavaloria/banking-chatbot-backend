// ─────────────────────────────────────────────────────────────────────────────
// Triage signal extraction prompt
// The LLM extracts signals ONLY. Final priority is computed deterministically.
// ─────────────────────────────────────────────────────────────────────────────

import type { LLMMessage }  from '../types';
import type { IntentResult } from '../../contracts/intent.contract';

const SYSTEM_PROMPT = `You are a triage signal extractor for a BFSI customer support system.

Your job is to extract urgency and severity signals from the customer message and context.
Do NOT compute the final priority — that is handled by a separate deterministic system.
Return ONLY valid JSON with the signal fields below.

OUTPUT FORMAT:
{
  "active_fraud_signal": <true if active fraud, unauthorized access, or card theft is indicated>,
  "account_compromise_signal": <true if account security may be compromised>,
  "access_to_funds_blocked": <true if customer cannot access their money>,
  "multiple_transactions": <true if multiple transactions are affected>,
  "high_value_amount": <true if amount mentioned is large (subjectively significant, e.g. >10000 in local currency)>,
  "aging_signal": <true if customer mentions delay, waiting a long time, or previous failed attempts>,
  "urgency_language": "low" | "medium" | "high",
  "financial_impact": "low" | "medium" | "high",
  "evidence": ["<short reason for each signal that is true>"]
}

RULES:
- active_fraud_signal: true for unauthorized_transaction, lost/stolen card with suspicious transactions
- account_compromise_signal: true when account credentials or access may be compromised by a third party
- access_to_funds_blocked: true when customer explicitly cannot withdraw or use their money
- urgency_language "high": words like urgent, emergency, immediately, ASAP, right now
- urgency_language "medium": words like soon, worried, concerned, please help
- urgency_language "low": neutral or no urgency language
- financial_impact "high": large amounts, inability to pay bills, salary affected
- financial_impact "medium": moderate amounts, inconvenience
- financial_impact "low": small amounts, informational queries
- Return false for signals you are not confident about — do not over-trigger`;

export function buildTriageMessages(
  userMessage: string,
  intentResult: IntentResult
): LLMMessage[] {
  const summary  = intentResult.issue_components[0]?.summary ?? intentResult.intent_type;
  const entities = intentResult.entities;

  const userContent = [
    `CLASSIFIED INTENT: ${intentResult.intent_type} (${intentResult.intent_group})`,
    `ISSUE SUMMARY: ${summary}`,
    entities.amount          != null ? `AMOUNT MENTIONED: ${entities.amount}` : null,
    entities.urgency_cue               ? `URGENCY CUE: ${entities.urgency_cue}` : null,
    entities.date_reference            ? `DATE REFERENCE: ${entities.date_reference}` : null,
    entities.reported_action           ? `REPORTED ACTION: ${entities.reported_action}` : null,
    '',
    `CUSTOMER MESSAGE: "${userMessage}"`,
    '',
    'Extract triage signals and return JSON only.',
  ].filter(Boolean).join('\n');

  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user',   content: userContent },
  ];
}