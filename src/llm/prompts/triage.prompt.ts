// ─────────────────────────────────────────────────────────────────────────────
// Triage Prompt — Gemini signal extraction
//
// The LLM extracts contextual signals from the customer message.
// The deterministic matrix + overrides in triage.agent.ts are always
// authoritative — the LLM only provides signal input, never the final priority.
//
// ─────────────────────────────────────────────────────────────────────────────

import type { IntentResult } from '../../contracts/intent.contract';
import type { LLMMessage }   from '../types';

// ---------------------------------------------------------------------------
// Signal definitions — used in the system prompt
//
// STRICT RULES per signal (read carefully before editing):
//
// active_fraud_signal
//   TRUE ONLY when the customer explicitly reports:
//     - Unauthorized transactions they did not make
//     - Stolen card
//     - Hacked account (someone else gained access)
//     - Someone else making transactions without permission
//   FALSE for: account on hold, account restricted, failed transfer,
//   double charge, refund issues, account access issues caused by forgotten
//   password or system lockout.
//
// account_compromise_signal
//   TRUE ONLY when the customer explicitly says someone else accessed or
//   took control of their account without permission — i.e., hacking,
//   phishing, unauthorized login by a third party.
//   FALSE for: account restricted, account on hold, account flagged,
//   KYC issues, system-initiated restrictions, forgotten password.
//
// access_to_funds_blocked
//   TRUE ONLY when the customer explicitly states they CANNOT currently
//   withdraw, pay, or transfer money due to an account issue AND expresses
//   an immediate need to access funds.
//   REQUIRED: both conditions must be present —
//     (1) account is blocked/restricted/on hold AND
//     (2) customer explicitly states they need to access money right now.
//   FALSE for:
//     - "My account is on hold" (no explicit funds need stated)
//     - "My account has been restricted" (no explicit funds need stated)
//     - "My account is flagged" (no explicit funds need stated)
//     - Double charge, refund issue, failed transfer (not an access block)
//     - "I need it reversed urgently" (not a funds access block)
//   TRUE examples:
//     - "I cannot withdraw cash and I need money for an emergency"
//     - "My account is frozen and I cannot pay my hospital bill today"
//     - "I am locked out and cannot access my money"
//     - "My account is suspended and I have bills to pay today"
//     - "I cannot make any transactions and I need to pay rent"
//
// multiple_transactions
//   TRUE when the customer mentions 2 or more separate unauthorized/failed
//   transactions, or uses words like "multiple", "several", "5 transactions".
//
// high_value_amount
//   TRUE when the customer mentions an amount >= 10,000 PHP (or equivalent).
//
// aging_signal
//   TRUE when the customer mentions a specific past date, number of days
//   waiting, or time elapsed (e.g. "3 days ago", "last week", "two weeks").
//
// urgency_language
//   "high"   — customer uses words: urgent, emergency, immediately, ASAP,
//              right now, today, tonight, cannot wait.
//   "medium" — customer implies time sensitivity without explicit urgency words.
//   "low"    — no urgency language present.
//
// financial_impact
//   "high"   — amount >= 10,000 PHP or customer describes major financial harm.
//   "medium" — amount between 1 and 9,999 PHP or moderate financial concern.
//   "low"    — no amount mentioned or minor concern.
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are a triage signal extractor for a BFSI customer support system.

Your job is to extract EXACTLY the signals present in the customer message.
Do NOT infer, escalate, or assume context beyond what is explicitly stated.
Be conservative — when in doubt, set a flag to false.

Extract these signals and return ONLY valid JSON, no markdown, no explanation:

{
  "active_fraud_signal": boolean,
  "account_compromise_signal": boolean,
  "access_to_funds_blocked": boolean,
  "multiple_transactions": boolean,
  "high_value_amount": boolean,
  "aging_signal": boolean,
  "urgency_language": "low" | "medium" | "high",
  "financial_impact": "low" | "medium" | "high",
  "evidence": string[]
}

SIGNAL RULES — follow these exactly:

active_fraud_signal = true ONLY IF the customer reports:
  - Transactions they explicitly did NOT authorize or make
  - A stolen card
  - Someone hacking or breaking into their account
  - A third party making transactions without their permission
  → false for: account on hold, restricted, flagged, failed transfer, double charge, refund, locked out

account_compromise_signal = true ONLY IF a third party explicitly accessed or
  took control of the customer's account without permission (hacking, phishing,
  unauthorized login).
  → false for: account restricted, on hold, flagged, system lockout, KYC hold,
    forgotten password, double charge, refund issue

access_to_funds_blocked = true ONLY IF BOTH of the following are present:
  (1) The account is blocked, frozen, suspended, restricted, or on hold
  (2) The customer explicitly states they need to access money right now
      (paying bills, withdrawing cash, making a payment today)
  → false if only condition (1) is present without condition (2)
  → false for: double charge, refund issue, failed transfer, "I need it reversed"
  → true examples:
      "My account is frozen and I cannot pay my hospital bill"
      "Account suspended and I have bills to pay today"
      "I am locked out and cannot access my money for emergency"
      "I cannot make any transactions and I need to pay rent"
  → false examples:
      "My account is on hold" (no explicit funds need)
      "My account has been restricted" (no explicit funds need)
      "My loan payment was debited twice and I need it reversed urgently"
      "My account is flagged and I want it resolved"

multiple_transactions = true ONLY IF the customer mentions 2 or more separate
  transactions, or uses words like "multiple", "several", "5 transactions", etc.

high_value_amount = true ONLY IF the customer mentions an amount >= 10,000 PHP
  or equivalent currency amount.

aging_signal = true IF the customer mentions a specific past date, number of
  days waiting, or elapsed time (e.g., "3 days ago", "last week", "two weeks").

urgency_language:
  "high"   → customer uses: urgent, emergency, immediately, ASAP, right now,
              today, tonight, cannot wait, need it now
  "medium" → customer implies time sensitivity without explicit urgency words
  "low"    → no urgency language

financial_impact:
  "high"   → amount >= 10,000 PHP or major financial harm described
  "medium" → amount 1–9,999 PHP or moderate concern
  "low"    → no amount or minor concern

evidence: list 1-3 short phrases from the message that support your signal values.
  If a signal is false, do not include evidence for it.

IMPORTANT: Return ONLY the JSON object. No markdown fences, no explanation text.`;

// ---------------------------------------------------------------------------
// Build triage messages for Gemini
// ---------------------------------------------------------------------------

export function buildTriageMessages(
  userMessage: string,
  intentResult: IntentResult
): LLMMessage[] {
  const userContent = `Customer message: "${userMessage}"

Detected intent: ${intentResult.intent_type}
Intent group: ${intentResult.intent_group}
Entities detected: ${JSON.stringify(intentResult.entities)}

Extract triage signals from the customer message following the rules exactly.`;

  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user',   content: userContent   },
  ];
}