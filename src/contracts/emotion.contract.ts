// ─────────────────────────────────────────────────────────────────────────────
// Emotion Contract
// Output of the Emotion Agent. Consumed by the Triage Agent (soft signal that
// can upgrade urgency once) and the Response Agent (tone modifier).
//
// The Emotion Agent never directly sets priority or routing — it only provides
// an additional signal. The deterministic priority matrix and the policy
// branches remain authoritative.
// ─────────────────────────────────────────────────────────────────────────────

export type EmotionLabel =
  | 'neutral'
  | 'anxious'      // worried, scared, panicked
  | 'frustrated'   // annoyed, fed up, repeated attempts
  | 'angry'        // hostile, accusatory, threatening to close account
  | 'confused'     // doesn't understand, asks the same question differently
  | 'satisfied';   // thankful, positive

/** Where the emotion verdict came from. */
export type EmotionSource = 'rule' | 'llm' | 'fallback';

export interface EmotionResult {
  /** Detected emotion label. 'neutral' is the safe default. */
  label: EmotionLabel;
  /** Strength of the signal, 0.0 - 1.0. */
  intensity: number;
  /** Confidence in the label assignment, 0.0 - 1.0. */
  confidence: number;
  /** Which path produced this result. */
  source: EmotionSource;
  /**
   * Short strings explaining the verdict.
   * Used for audit trails and the supervisor analytics dashboard.
   */
  evidence: string[];
}

/** Threshold above which emotion may influence Triage urgency. */
export const EMOTION_TRIAGE_INTENSITY_THRESHOLD = 0.7;

/** Threshold above which emotion is surfaced in the UI. */
export const EMOTION_UI_INTENSITY_THRESHOLD = 0.6;
