// ─────────────────────────────────────────────────────────────────────────────
// Emotion Agent — hybrid (rule-based lexicon + LLM fallback)
//
// Mirrors the Intent Agent's pattern (LLM via model-router with primary/fallback):
//   1. Rule-based lexicon pass (deterministic, no network).
//   2. If the rule pass returns 'neutral' or low confidence AND we are not in
//      test mode, ask the configured small/cheap model for a second opinion.
//   3. If the LLM fails or is unavailable, return the rule result (or a
//      neutral safe fallback).
//
// The agent is best-effort: any failure resolves to a neutral result with
// `source: 'fallback'`. It never throws.
// ─────────────────────────────────────────────────────────────────────────────

import type { EmotionLabel, EmotionResult } from '../contracts/emotion.contract';

import { scoreEmotionRuleBased }      from '../utils/emotion-lexicon';
import { callWithFallback }         from '../llm/model-router';
import { buildEmotionMessages }       from '../llm/prompts/emotion.prompt';
import { env }                        from '../config/env';

const ALLOWED_LABELS: ReadonlyArray<EmotionLabel> = [
  'neutral', 'anxious', 'frustrated', 'angry', 'confused', 'satisfied',
];

/** Confidence below which we treat the rule pass as unsure and consult the LLM. */
const RULE_LOW_CONFIDENCE = 0.6;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function clamp01(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function safeLabel(value: unknown): EmotionLabel | null {
  if (typeof value !== 'string') return null;
  const v = value.toLowerCase() as EmotionLabel;
  return ALLOWED_LABELS.includes(v) ? v : null;
}

function safeEvidence(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((e): e is string => typeof e === 'string')
    .slice(0, 5)
    .map(e => `[llm] ${e}`);
}

function neutralFallback(reason: string): EmotionResult {
  return {
    label:      'neutral',
    intensity:  0,
    confidence: 0,
    source:     'fallback',
    evidence:   [reason],
  };
}

// ---------------------------------------------------------------------------
// LLM pass
// ---------------------------------------------------------------------------

async function classifyEmotionLLM(userMessage: string): Promise<EmotionResult | null> {
  if (!env.GOOGLE_AI_STUDIO_API_KEY && !env.MISTRAL_API_KEY) return null;

  try {
    const messages = buildEmotionMessages(userMessage);

    const llmResponse = await callWithFallback({
      messages,
      primaryModel:  env.PRIMARY_TRIAGE_MODEL,
      fallbackModel: env.FALLBACK_TRIAGE_MODEL,
      temperature:   0.1,
      maxTokens:     256,
      agentName:     'EmotionAgent',
    });

    const raw = llmResponse.text.trim();
    let matchedLabel:     EmotionLabel | null = null;
    let parsedIntensity   = 0.5;
    let parsedConfidence  = 0.70;
    let parsedEvidence:   string[] = [];

    // Tier 1: try to parse as JSON and extract the emotion from known keys.
    // Handles responses like { "label": "neutral" }, { "emotion": "angry" },
    // or fenced variants like ```json\n{ "label": "frustrated" }\n```.
    try {
      const jsonText = raw.replace(/```json/gi, '').replace(/```/g, '').trim();
      const obj      = JSON.parse(jsonText);
      const candidate = (
        obj['emotion']   ??
        obj['label']     ??
        obj['sentiment'] ??
        ''
      ).toString().toLowerCase().trim();
      const found = safeLabel(candidate);
      if (found) {
        matchedLabel    = found;
        parsedIntensity = clamp01(obj['intensity'],  0.5);
        parsedConfidence= clamp01(obj['confidence'], 0.70);
        parsedEvidence  = safeEvidence(obj['evidence']);
      }
    } catch {
      // Not valid JSON — fall through to Tier 2
    }

    // Tier 2: strip all non-alpha characters and match directly.
    // Handles plain words wrapped in markdown/punctuation like `neutral`,
    // **angry**, "frustrated.", etc.
    if (!matchedLabel) {
      const cleaned  = raw.toLowerCase().replace(/[^a-z]/g, '').trim();
      matchedLabel   = ALLOWED_LABELS.find(e => cleaned === e) ?? null;
    }

    if (!matchedLabel) {
      console.warn('[EmotionAgent] Unparseable LLM output:', { raw: raw.slice(0, 100) });
      return null;
    }

    return {
      label:      matchedLabel,
      intensity:  matchedLabel === 'neutral' ? 0 : parsedIntensity,
      confidence: parsedConfidence,
      source:     'llm',
      evidence:   parsedEvidence.length > 0
        ? parsedEvidence
        : ['[llm] single-word response matched after cleaning'],
    };
  } catch (err) {
    console.warn(
      '[EmotionAgent] LLM classification failed',
      err instanceof Error ? err.message : err
    );
    return null;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Detect the customer's emotion from a single user message.
 *
 * Never throws — failures resolve to a neutral fallback so the rest of the
 * pipeline always receives a usable EmotionResult.
 */
export async function detectEmotion(userMessage: string): Promise<EmotionResult> {
  if (!userMessage || typeof userMessage !== 'string' || userMessage.trim() === '') {
    return neutralFallback('empty message');
  }

  const ruleResult = scoreEmotionRuleBased(userMessage);

  // Strong rule hit — trust it, no LLM call needed.
  if (ruleResult.source === 'rule' && ruleResult.confidence >= RULE_LOW_CONFIDENCE) {
    return ruleResult;
  }

  // In test mode, skip the network entirely.
  if (env.NODE_ENV === 'test') {
    return ruleResult;
  }

  // Rule pass was either 'neutral'-fallback or below the confidence threshold.
  // Ask the LLM for a second opinion.
  const llmResult = await classifyEmotionLLM(userMessage);

  if (!llmResult) {
    // LLM unavailable or failed — return whichever rule output we have.
    return ruleResult;
  }

  // If the LLM agrees on a non-neutral label, prefer it (it gives us nuance
  // the lexicon missed). If the LLM also says 'neutral', return the LLM result
  // so its confidence number flows through.
  if (llmResult.label !== 'neutral') {
    return llmResult;
  }

  // LLM neutral but rule pass found *something* — keep the rule pass to avoid
  // throwing away a valid weak signal.
  if (ruleResult.source === 'rule' && ruleResult.label !== 'neutral') {
    return {
      ...ruleResult,
      evidence: [...ruleResult.evidence, '[llm] confirmed weak signal as neutral'],
    };
  }

  return llmResult;
}
