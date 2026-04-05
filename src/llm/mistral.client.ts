// ─────────────────────────────────────────────────────────────────────────────
// Mistral HTTP client
// Used for Response Agent.
// Mistral follows the OpenAI-compatible chat completions format.
// ─────────────────────────────────────────────────────────────────────────────

import { env }                          from '../config/env';
import type { LLMRequest, LLMResponse } from './types';
import { LLMProviderError }             from './types';

const MISTRAL_API_URL = 'https://api.mistral.ai/v1/chat/completions';

export async function callMistral(req: LLMRequest): Promise<LLMResponse> {
  const apiKey = env.MISTRAL_API_KEY;
  if (!apiKey) throw new Error('MISTRAL_API_KEY is not set.');

  const body = {
    model:       req.model,
    messages:    req.messages,
    temperature: req.temperature,
    max_tokens:  req.maxTokens,
  };

  const res = await fetch(MISTRAL_API_URL, {
    method:  'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '(unreadable)');
    throw new LLMProviderError('Mistral', res.status, text);
  }

  const data   = await res.json() as any;
  const choice = data?.choices?.[0];
  if (!choice) throw new LLMProviderError('Mistral', 200, 'No choices in response');

  return {
    text:       choice.message?.content ?? '',
    model_used: data.model ?? req.model,
    usage: {
      prompt_tokens:     data.usage?.prompt_tokens     ?? 0,
      completion_tokens: data.usage?.completion_tokens ?? 0,
    },
  };
}