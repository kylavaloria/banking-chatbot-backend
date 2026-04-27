// ─────────────────────────────────────────────────────────────────────────────
// Emotion lexicon — rule-based scorer
//
// Conservative on purpose. Only flips off `neutral` when at least one keyword
// match is found. Intensity is derived from the strongest match weight,
// boosted by ALL-CAPS, exclamation-mark runs, and intensifier words.
//
// The deterministic Triage matrix and the Policy Agent are not allowed to
// upgrade priority on rule-based emotion alone unless intensity crosses
// EMOTION_TRIAGE_INTENSITY_THRESHOLD (see emotion.contract.ts).
// ─────────────────────────────────────────────────────────────────────────────

import type { EmotionLabel, EmotionResult } from '../contracts/emotion.contract';

interface LexiconEntry {
  /** Lowercased phrase to substring-match against the normalized message. */
  phrase: string;
  /** Base weight for this phrase, 0.0 - 1.0. */
  weight: number;
}

// ---------------------------------------------------------------------------
// Per-label keyword sets
// Phrases are matched as substrings on a lowercased + contraction-expanded
// version of the message. Weights reflect how strong the signal typically is.
// ---------------------------------------------------------------------------

const ANXIOUS: LexiconEntry[] = [
  { phrase: 'panic',                weight: 0.85 },
  { phrase: 'panicking',            weight: 0.9  },
  { phrase: 'panicked',             weight: 0.85 },
  { phrase: 'scared',               weight: 0.75 },
  { phrase: 'terrified',            weight: 0.9  },
  { phrase: 'worried',              weight: 0.6  },
  { phrase: 'anxious',              weight: 0.7  },
  { phrase: 'please help',          weight: 0.7  },
  { phrase: 'please do something',  weight: 0.75 },
  { phrase: 'i don\'t know what to do', weight: 0.8 },
  { phrase: 'i do not know what to do', weight: 0.8 },
  { phrase: 'emergency',            weight: 0.75 },
  { phrase: 'desperate',            weight: 0.8  },
  { phrase: 'my whole salary',      weight: 0.8  },
  { phrase: 'all my money',         weight: 0.75 },
  { phrase: 'losing sleep',         weight: 0.7  },
];

const FRUSTRATED: LexiconEntry[] = [
  { phrase: 'frustrated',          weight: 0.8  },
  { phrase: 'frustrating',         weight: 0.8  },
  { phrase: 'fed up',              weight: 0.85 },
  { phrase: 'sick of',             weight: 0.8  },
  { phrase: 'tired of',            weight: 0.7  },
  { phrase: 'annoyed',             weight: 0.7  },
  { phrase: 'annoying',            weight: 0.65 },
  { phrase: 'this is taking forever', weight: 0.75 },
  { phrase: 'i\'ve been waiting',  weight: 0.6  },
  { phrase: 'i have been waiting', weight: 0.6  },
  { phrase: 'still not resolved',  weight: 0.7  },
  { phrase: 'nobody is helping',   weight: 0.8  },
  { phrase: 'no one is helping',   weight: 0.8  },
  { phrase: 'again and again',     weight: 0.7  },
  { phrase: 'told you already',    weight: 0.75 },
  { phrase: 'as i said before',    weight: 0.65 },
];

const ANGRY: LexiconEntry[] = [
  { phrase: 'unacceptable',        weight: 0.85 },
  { phrase: 'ridiculous',          weight: 0.8  },
  { phrase: 'terrible service',    weight: 0.85 },
  { phrase: 'worst bank',          weight: 0.9  },
  { phrase: 'worst service',       weight: 0.9  },
  { phrase: 'i will sue',          weight: 0.95 },
  { phrase: 'sue you',             weight: 0.95 },
  { phrase: 'close my account',    weight: 0.85 },
  { phrase: 'closing my account',  weight: 0.85 },
  { phrase: 'switch banks',        weight: 0.7  },
  { phrase: 'go to the media',     weight: 0.9  },
  { phrase: 'report you',          weight: 0.8  },
  { phrase: 'this is a scam',      weight: 0.85 },
  { phrase: 'you people',          weight: 0.6  },
  { phrase: 'incompetent',         weight: 0.85 },
  { phrase: 'absolute joke',       weight: 0.85 },
];

const CONFUSED: LexiconEntry[] = [
  { phrase: 'i don\'t understand', weight: 0.8  },
  { phrase: 'i do not understand', weight: 0.8  },
  { phrase: 'what do you mean',    weight: 0.75 },
  { phrase: 'i\'m confused',       weight: 0.85 },
  { phrase: 'i am confused',       weight: 0.85 },
  { phrase: 'this is confusing',   weight: 0.75 },
  { phrase: 'doesn\'t make sense', weight: 0.7  },
  { phrase: 'does not make sense', weight: 0.7  },
  { phrase: 'i\'m lost',           weight: 0.7  },
  { phrase: 'not sure what',       weight: 0.55 },
  { phrase: 'can you clarify',     weight: 0.6  },
  { phrase: 'explain again',       weight: 0.65 },
];

const SATISFIED: LexiconEntry[] = [
  { phrase: 'thank you',           weight: 0.65 },
  { phrase: 'thanks',              weight: 0.55 },
  { phrase: 'appreciate',          weight: 0.7  },
  { phrase: 'much appreciated',    weight: 0.8  },
  { phrase: 'great service',       weight: 0.85 },
  { phrase: 'really helpful',      weight: 0.75 },
  { phrase: 'you\'ve been great',  weight: 0.85 },
  { phrase: 'awesome',             weight: 0.7  },
  { phrase: 'perfect, thanks',     weight: 0.85 },
  { phrase: 'all sorted',          weight: 0.7  },
];

const LEXICON: Record<Exclude<EmotionLabel, 'neutral'>, LexiconEntry[]> = {
  anxious:    ANXIOUS,
  frustrated: FRUSTRATED,
  angry:      ANGRY,
  confused:   CONFUSED,
  satisfied:  SATISFIED,
};

// ---------------------------------------------------------------------------
// Intensity boosters
// ---------------------------------------------------------------------------

const INTENSIFIERS = [
  'very', 'extremely', 'so', 'really', 'absolutely', 'completely',
  'totally', 'beyond', 'incredibly',
] as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function expandContractions(text: string): string {
  return text
    .replace(/can't/g,    'cannot')
    .replace(/won't/g,    'will not')
    .replace(/don't/g,    'do not')
    .replace(/doesn't/g,  'does not')
    .replace(/didn't/g,   'did not')
    .replace(/isn't/g,    'is not')
    .replace(/wasn't/g,   'was not')
    .replace(/aren't/g,   'are not')
    .replace(/haven't/g,  'have not')
    .replace(/hasn't/g,   'has not')
    .replace(/i'm/g,      'i am')
    .replace(/i've/g,     'i have')
    .replace(/you're/g,   'you are')
    .replace(/you've/g,   'you have');
}

function countCapsWords(originalText: string): number {
  const tokens = originalText.split(/\s+/).filter(t => t.length >= 3);
  let caps = 0;
  for (const t of tokens) {
    const letters = t.replace(/[^A-Za-z]/g, '');
    if (letters.length >= 3 && letters === letters.toUpperCase()) caps++;
  }
  return caps;
}

function countExclamationRuns(originalText: string): number {
  const matches = originalText.match(/!{2,}/g);
  return matches?.length ?? 0;
}

function hasIntensifier(normalized: string): boolean {
  return INTENSIFIERS.some(w => new RegExp(`\\b${w}\\b`).test(normalized));
}

interface LabelScore {
  label: EmotionLabel;
  baseWeight: number;
  matchCount: number;
  matchedPhrases: string[];
}

function scoreLabel(
  label: Exclude<EmotionLabel, 'neutral'>,
  normalized: string
): LabelScore {
  const entries = LEXICON[label];
  let baseWeight = 0;
  let matchCount = 0;
  const matchedPhrases: string[] = [];

  for (const entry of entries) {
    if (normalized.includes(entry.phrase)) {
      matchCount++;
      matchedPhrases.push(entry.phrase);
      if (entry.weight > baseWeight) baseWeight = entry.weight;
    }
  }

  return { label, baseWeight, matchCount, matchedPhrases };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run the rule-based emotion scorer on a raw user message.
 *
 * Returns an EmotionResult with `source: 'rule'` when at least one keyword
 * matches, otherwise `source: 'fallback'` with `label: 'neutral'`.
 *
 * The Emotion Agent is responsible for invoking the LLM fallback when this
 * function returns 'neutral' with low confidence.
 */
export function scoreEmotionRuleBased(rawMessage: string): EmotionResult {
  if (!rawMessage || typeof rawMessage !== 'string') {
    return {
      label:      'neutral',
      intensity:  0,
      confidence: 0,
      source:     'fallback',
      evidence:   ['empty or invalid message'],
    };
  }

  const normalized = expandContractions(rawMessage.toLowerCase());

  const scores: LabelScore[] = (Object.keys(LEXICON) as Array<Exclude<EmotionLabel, 'neutral'>>)
    .map(label => scoreLabel(label, normalized));

  const best = scores.reduce(
    (acc, s) => (s.baseWeight > acc.baseWeight ? s : acc),
    { label: 'neutral' as EmotionLabel, baseWeight: 0, matchCount: 0, matchedPhrases: [] as string[] }
  );

  if (best.baseWeight === 0) {
    return {
      label:      'neutral',
      intensity:  0,
      confidence: 0.25,
      source:     'fallback',
      evidence:   ['[rule] no lexicon match'],
    };
  }

  // Intensity = base weight + small boosts for ALL-CAPS, !!! runs, intensifiers,
  // and additional matched phrases beyond the first.
  const capsWords         = countCapsWords(rawMessage);
  const exclamationRuns   = countExclamationRuns(rawMessage);
  const hasIntensifierHit = hasIntensifier(normalized);

  let intensity = best.baseWeight;
  if (capsWords >= 1)         intensity += 0.05 + Math.min(capsWords - 1, 2) * 0.02;
  if (exclamationRuns >= 1)   intensity += 0.05 + Math.min(exclamationRuns - 1, 2) * 0.02;
  if (hasIntensifierHit)      intensity += 0.05;
  if (best.matchCount >= 2)   intensity += Math.min(best.matchCount - 1, 3) * 0.03;

  intensity = Math.min(Math.max(intensity, 0), 1);

  // Confidence — higher when multiple phrases lined up or boosters fired.
  let confidence = 0.55 + Math.min(best.matchCount - 1, 2) * 0.1;
  if (capsWords >= 1 || exclamationRuns >= 1 || hasIntensifierHit) confidence += 0.05;
  confidence = Math.min(Math.max(confidence, 0), 1);

  const evidence: string[] = [
    `[rule] matched ${best.matchCount} ${best.label} phrase${best.matchCount === 1 ? '' : 's'}: ${best.matchedPhrases.slice(0, 3).join(', ')}`,
  ];
  if (capsWords >= 1)       evidence.push(`[rule] all-caps words: ${capsWords}`);
  if (exclamationRuns >= 1) evidence.push(`[rule] exclamation runs: ${exclamationRuns}`);
  if (hasIntensifierHit)    evidence.push('[rule] intensifier present');

  return {
    label:      best.label,
    intensity,
    confidence,
    source:     'rule',
    evidence,
  };
}

/** Exposed for tests so threshold tuning can be exercised directly. */
export const __test = {
  expandContractions,
  countCapsWords,
  countExclamationRuns,
  hasIntensifier,
};
