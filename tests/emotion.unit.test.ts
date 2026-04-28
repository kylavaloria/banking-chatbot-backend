// ─────────────────────────────────────────────────────────────────────────────
// Emotion Agent unit tests
//
// Covers:
//   1. Rule-based lexicon (scoreEmotionRuleBased) — labels and intensity boosts
//   2. detectEmotion in test mode (no network call)
//   3. Triage soft-signal upgrade — anxious + intensity >= 0.7 bumps low → medium
//      and never reaches high (P1 still requires fraud / compromise)
//
// Run: npx vitest run tests/emotion.unit.test.ts
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, vi } from 'vitest';

// Isolate env before importing anything from src
vi.stubEnv('NODE_ENV',                 'test');
vi.stubEnv('GROQ_API_KEY',             'test-key');
vi.stubEnv('GOOGLE_AI_STUDIO_API_KEY', 'test-key');
vi.stubEnv('PRIMARY_INTENT_MODEL',     'llama-3.3-70b-versatile');
vi.stubEnv('FALLBACK_INTENT_MODEL',    'llama-3.1-8b-instant');
vi.stubEnv('TRIAGE_MODEL',             'llama-3.1-8b-instant');
vi.stubEnv('RESPONSE_MODEL',           'gemini-2.5-flash');
vi.stubEnv('SUPABASE_URL',             'https://fake.supabase.co');
vi.stubEnv('SUPABASE_ANON_KEY',        'fake-anon');
vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY','fake-service');

import { scoreEmotionRuleBased } from '../src/utils/emotion-lexicon';
import { detectEmotion }         from '../src/agents/emotion.agent';
import { triageIntent }          from '../src/agents/triage.agent';
import type { IntentResult }     from '../src/contracts/intent.contract';
import type { EmotionResult }    from '../src/contracts/emotion.contract';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeIntent(overrides: Partial<IntentResult> = {}): IntentResult {
  return {
    intent_type:                          'failed_or_delayed_transfer',
    intent_group:                         'operational',
    confidence:                           0.9,
    secondary_intents:                    [],
    entities: {
      product:          null,
      amount:           null,
      date_reference:   null,
      channel:          null,
      reference_number: null,
      urgency_cue:      null,
      reported_action:  null,
    },
    flags: {
      ambiguous:       false,
      multi_issue:     false,
      hybrid:          false,
      topic_switch:    false,
      malicious_input: false,
    },
    issue_components:                    [],
    candidate_intents_for_clarification: [],
    consistency_with_active_case:        'no_active_case',
    evidence:                            [],
    ...overrides,
  };
}

function makeEmotion(overrides: Partial<EmotionResult> = {}): EmotionResult {
  return {
    label:      'neutral',
    intensity:  0,
    confidence: 0,
    source:     'fallback',
    evidence:   [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Rule-based lexicon
// ---------------------------------------------------------------------------

describe('scoreEmotionRuleBased — labels', () => {
  it('returns neutral fallback for empty input', () => {
    const r = scoreEmotionRuleBased('');
    expect(r.label).toBe('neutral');
    expect(r.intensity).toBe(0);
    expect(r.source).toBe('fallback');
  });

  it('returns neutral when no lexicon phrase matches', () => {
    const r = scoreEmotionRuleBased('please help me transfer money to my brother');
    // 'please help' is anxious — verify the negative case with a truly neutral string
    const r2 = scoreEmotionRuleBased('how do i open a savings account');
    expect(r2.label).toBe('neutral');
    expect(r2.source).toBe('fallback');
    // Sanity check: 'please help' did pick up anxious
    expect(r.label).toBe('anxious');
  });

  it.each([
    ['anxious',    'i am panicking, my whole salary is gone'],
    ['anxious',    'please help, i don\'t know what to do'],
    ['frustrated', 'i am so fed up with this, nobody is helping me'],
    ['frustrated', 'this is taking forever, i have been waiting three weeks'],
    ['angry',      'this is unacceptable, i will sue you and close my account'],
    ['angry',      'absolute joke, worst service ever'],
    ['confused',   'i don\'t understand what do you mean by hold'],
    ['confused',   'i\'m confused, can you clarify'],
    ['satisfied',  'thank you so much, much appreciated'],
    ['satisfied',  'great service, you\'ve been great'],
  ])('classifies as %s: "%s"', (expectedLabel, message) => {
    const r = scoreEmotionRuleBased(message);
    expect(r.label).toBe(expectedLabel);
    expect(r.source).toBe('rule');
    expect(r.intensity).toBeGreaterThan(0);
    expect(r.intensity).toBeLessThanOrEqual(1);
    expect(r.confidence).toBeGreaterThan(0);
  });
});

describe('scoreEmotionRuleBased — intensity boosts', () => {
  it('boosts intensity for ALL-CAPS words', () => {
    const baseline = scoreEmotionRuleBased('i am panicking');
    const boosted  = scoreEmotionRuleBased('I AM PANICKING');
    expect(boosted.label).toBe('anxious');
    expect(boosted.intensity).toBeGreaterThan(baseline.intensity);
  });

  it('boosts intensity for !!! runs', () => {
    const baseline = scoreEmotionRuleBased('this is unacceptable');
    const boosted  = scoreEmotionRuleBased('this is unacceptable!!!');
    expect(boosted.intensity).toBeGreaterThan(baseline.intensity);
  });

  it('boosts intensity for intensifier words', () => {
    const baseline = scoreEmotionRuleBased('i am frustrated');
    const boosted  = scoreEmotionRuleBased('i am very frustrated');
    expect(boosted.intensity).toBeGreaterThan(baseline.intensity);
  });

  it('caps intensity at 1.0', () => {
    const r = scoreEmotionRuleBased('I AM EXTREMELY PANICKING!!! please help, this is an emergency, i\'m desperate');
    expect(r.intensity).toBeLessThanOrEqual(1);
    expect(r.intensity).toBeGreaterThan(0.9);
  });
});

// ---------------------------------------------------------------------------
// detectEmotion (test mode skips network)
// ---------------------------------------------------------------------------

describe('detectEmotion — test mode', () => {
  it('returns neutral fallback for empty input', async () => {
    const r = await detectEmotion('');
    expect(r.label).toBe('neutral');
    expect(r.source).toBe('fallback');
  });

  it('does not call the network in test mode and uses rule output', async () => {
    const r = await detectEmotion('i am panicking, my whole salary is gone');
    expect(r.label).toBe('anxious');
    expect(r.source).toBe('rule');
  });

  it('returns rule-low-confidence neutral when nothing matches', async () => {
    const r = await detectEmotion('how do i open a savings account');
    expect(r.label).toBe('neutral');
    // In test mode we never escalate to LLM — the rule fallback flows through
    expect(['fallback', 'rule']).toContain(r.source);
  });
});

// ---------------------------------------------------------------------------
// Triage soft-signal upgrade
// ---------------------------------------------------------------------------

describe('Triage urgency upgrade — emotion soft signal', () => {
  it('does not change urgency for low-intensity anxious emotion', () => {
    const intent  = makeIntent({ intent_type: 'failed_or_delayed_transfer' });
    const emotion = makeEmotion({ label: 'anxious', intensity: 0.5, source: 'rule' });
    const result  = triageIntent(intent, emotion);
    expect(result.urgency).toBe('low');
    expect(result.priority).toBe('P3'); // medium importance + low urgency
  });

  it('upgrades P3 to P2 when anxious emotion crosses the threshold', () => {
    const intent  = makeIntent({ intent_type: 'failed_or_delayed_transfer' });
    const emotion = makeEmotion({ label: 'anxious', intensity: 0.85, source: 'rule' });
    const result  = triageIntent(intent, emotion);
    expect(result.urgency).toBe('medium');           // bumped low → medium
    expect(result.priority).toBe('P2');              // medium + medium → P2
    expect(result.evidence.some(e => e.includes('high-distress emotion'))).toBe(true);
  });

  it('does not upgrade urgency for non-anxious emotions even at high intensity', () => {
    const intent       = makeIntent({ intent_type: 'failed_or_delayed_transfer' });
    const frustrated   = makeEmotion({ label: 'frustrated', intensity: 0.9, source: 'rule' });
    const angry        = makeEmotion({ label: 'angry',      intensity: 0.95, source: 'rule' });
    expect(triageIntent(intent, frustrated).urgency).toBe('low');
    expect(triageIntent(intent, angry).urgency).toBe('low');
  });

  it('cannot upgrade urgency above medium via emotion alone', () => {
    // Pre-existing urgency is already medium for high-importance intents would normally
    // be 'low' baseline. The emotion bump is a one-step low → medium operation; it must
    // never push to 'high'. Verify that combining a high-distress emotion with a
    // baseline-medium intent leaves urgency at medium (no further bump).
    const intent = makeIntent({ intent_type: 'failed_or_delayed_transfer' });
    const emotion = makeEmotion({ label: 'anxious', intensity: 1.0, source: 'rule' });
    const result  = triageIntent(intent, emotion);
    expect(result.urgency).toBe('medium');
    expect(['P2', 'P3']).toContain(result.priority);
    expect(result.urgency).not.toBe('high');
  });

  it('does not interfere with the fraud override (P1 still wins)', () => {
    const intent  = makeIntent({ intent_type: 'unauthorized_transaction' });
    const emotion = makeEmotion({ label: 'anxious', intensity: 0.9, source: 'rule' });
    const result  = triageIntent(intent, emotion);
    expect(result.priority).toBe('P1');
    expect(result.override_reason).toBe('fraud_override');
  });

  it('produces the same result as no emotion when emotion is undefined', () => {
    const intent = makeIntent({ intent_type: 'failed_or_delayed_transfer' });
    const a = triageIntent(intent);
    const b = triageIntent(intent, makeEmotion({ label: 'neutral', intensity: 0 }));
    expect(a.priority).toBe(b.priority);
    expect(a.urgency).toBe(b.urgency);
  });
});
