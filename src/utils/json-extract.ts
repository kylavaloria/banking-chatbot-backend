// ─────────────────────────────────────────────────────────────────────────────
// JSON extraction from LLM text output
// LLMs sometimes wrap JSON in markdown code fences or add prose before/after.
// This utility extracts the first valid JSON object from any text.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Attempts to parse JSON from LLM output text.
 * Strips markdown code fences, then tries full parse, then first-brace extraction.
 * Returns null if no valid JSON object can be found.
 */
export function extractJSON(text: string): Record<string, unknown> | null {
  if (!text || typeof text !== 'string') return null;

  // Step 1: Strip markdown code fences
  let cleaned = text
    .replace(/^```(?:json)?\s*/im, '')
    .replace(/\s*```\s*$/im, '')
    .trim();

  // Step 2: Try direct parse
  try {
    const parsed = JSON.parse(cleaned);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // continue
  }

  // Step 3: Find first { ... } block
  const start = cleaned.indexOf('{');
  const end   = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;

  const slice = cleaned.slice(start, end + 1);
  try {
    const parsed = JSON.parse(slice);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return null;
  }

  return null;
}