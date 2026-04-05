// ─────────────────────────────────────────────────────────────────────────────
// Groq HTTP client — with single retry on 429
// ─────────────────────────────────────────────────────────────────────────────

import { env }                          from '../config/env';
import type { LLMRequest, LLMResponse } from './types';
import { LLMProviderError }             from './types';

const GROQ_API_URL   = 'https://api.groq.com/openai/v1/chat/completions';
const MAX_RETRY_WAIT = 15_000; // Never wait more than 15s before retrying

/**
 * Parses the suggested retry delay from Groq's 429 error message.
 * Returns milliseconds, or null if it cannot be parsed.
 * Examples: "Please try again in 3.74s" → 3740
 *           "Please try again in 329.999999ms" → 330
 */
function parseRetryAfterMs(body: string): number | null {
  const match = body.match(/Please try again in ([\d.]+)(ms|s)/i);
  if (!match) return null;
  const value = parseFloat(match[1]);
  return match[2] === 's' ? Math.ceil(value * 1000) : Math.ceil(value);
}

async function doRequest(
  apiKey: string,
  body: object
): Promise<Response> {
  return fetch(GROQ_API_URL, {
    method:  'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify(body),
  });
}

export async function callGroq(req: LLMRequest): Promise<LLMResponse> {
  const apiKey = env.GROQ_API_KEY;
  if (!apiKey) throw new Error('GROQ_API_KEY is not set.');

  const body = {
    model:       req.model,
    messages:    req.messages,
    temperature: req.temperature,
    max_tokens:  req.maxTokens,
  };

  let res = await doRequest(apiKey, body);

  // ── Retry once on 429 if the suggested wait is within our threshold ───────
  if (res.status === 429) {
    const rawText      = await res.text();
    const retryAfterMs = parseRetryAfterMs(rawText);

    if (retryAfterMs !== null && retryAfterMs <= MAX_RETRY_WAIT) {
      console.warn(
        `[Groq] Rate limited — waiting ${retryAfterMs}ms before retry (model: ${req.model})`
      );
      await new Promise(r => setTimeout(r, retryAfterMs + 200)); // +200ms buffer
      res = await doRequest(apiKey, body);
    }

    // If still 429 after retry (or wait was too long), throw so caller can fallback
    if (res.status === 429) {
      const secondBody = await res.text().catch(() => rawText);
      throw new LLMProviderError('Groq', 429, secondBody);
    }
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '(unreadable)');
    throw new LLMProviderError('Groq', res.status, text);
  }

  const data   = await res.json() as any;
  const choice = data?.choices?.[0];
  if (!choice) throw new LLMProviderError('Groq', 200, 'No choices in response');

  return {
    text:       choice.message?.content ?? '',
    model_used: data.model ?? req.model,
    usage: {
      prompt_tokens:     data.usage?.prompt_tokens     ?? 0,
      completion_tokens: data.usage?.completion_tokens ?? 0,
    },
  };
}