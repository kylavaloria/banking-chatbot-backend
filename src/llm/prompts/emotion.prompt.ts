// ─────────────────────────────────────────────────────────────────────────────
// Emotion prompt — Groq fallback classifier
//
// Produces a strict JSON object so the Emotion Agent can drop the LLM result
// into the same EmotionResult shape that the rule-based scorer returns.
// ─────────────────────────────────────────────────────────────────────────────

import type { LLMMessage } from '../types';

const SYSTEM_PROMPT = `You are an emotion classifier for a BFSI (Banking, Financial Services, Insurance) customer support system.

Read the customer message and decide which single emotion label best describes the writer.
Be conservative — when in doubt, return "neutral". Do NOT infer fraud, urgency, or intent.
You are NOT prioritising the case. You are only labelling emotion.

Allowed labels (pick exactly one):
  "neutral"     — calm, factual, no emotional language
  "anxious"     — worried, scared, panicked, desperate, fear of financial loss
  "frustrated"  — annoyed, fed up, repeated attempts, "I have been waiting"
  "angry"       — hostile, accusatory, threatens to close account, sue, switch banks
  "confused"    — does not understand, asks the same thing differently, "what do you mean"
  "satisfied"   — thankful, positive, thanks the team, says it is resolved

Return ONLY valid JSON, no markdown, no explanation:

{
  "label": "neutral" | "anxious" | "frustrated" | "angry" | "confused" | "satisfied",
  "intensity": number between 0.0 and 1.0,
  "confidence": number between 0.0 and 1.0,
  "evidence": string[]
}

RULES:
- intensity reflects how strongly the emotion is expressed in the message itself, not how serious the underlying issue is.
- For "neutral", intensity must be 0.0 and confidence reflects how certain you are it is neutral.
- evidence is 1-3 short verbatim or near-verbatim phrases from the message that justify the label.
- Never include any other field. Never wrap in markdown fences. Never include commentary.`;

export function buildEmotionMessages(userMessage: string): LLMMessage[] {
  const userContent =
    `Customer message: "${userMessage}"\n\n` +
    `Classify the emotion following the rules exactly. Return only the JSON object.`;

  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user',   content: userContent   },
  ];
}
