// ─────────────────────────────────────────────────────────────────────────────
// Embedding client — Mistral embed
// Returns a 1024-dimensional vector for each input string.
// ─────────────────────────────────────────────────────────────────────────────

import { env } from '../config/env';
import { LLMProviderError } from '../llm/types';

const MISTRAL_EMBED_URL = 'https://api.mistral.ai/v1/embeddings';

/**
 * Embeds a single string. Returns a float array.
 */
export async function embed(text: string): Promise<number[]> {
  return embedBatch([text]).then(results => results[0]);
}

/**
 * Embeds multiple strings in one API call.
 * Mistral embed supports batch inputs natively.
 */
export async function embedBatch(texts: string[]): Promise<number[][]> {
  const apiKey = env.MISTRAL_API_KEY;
  if (!apiKey) throw new Error('MISTRAL_API_KEY is not set — required for embeddings.');

  const res = await fetch(MISTRAL_EMBED_URL, {
    method:  'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify({
      model: env.EMBEDDING_MODEL,
      input: texts,
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '(unreadable)');
    throw new LLMProviderError('Mistral-embed', res.status, text);
  }

  const data = await res.json() as any;
  return data.data.map((item: any) => item.embedding as number[]);
}

/**
 * Cosine similarity between two equal-length vectors.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot  += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  if (magA === 0 || magB === 0) return 0;
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}