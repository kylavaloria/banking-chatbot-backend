// ─────────────────────────────────────────────────────────────────────────────
// Groq HTTP client
// Used for Intent Agent and Triage Agent.
// No SDK — plain fetch for minimal dependency footprint.
// ─────────────────────────────────────────────────────────────────────────────

import { env }                          from '../config/env';
import type { LLMRequest, LLMResponse } from './types';
import { LLMProviderError }             from './types';

const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';

export async function callGroq(req: LLMRequest): Promise<LLMResponse> {
  const apiKey = env.GROQ_API_KEY;
  if (!apiKey) throw new Error('GROQ_API_KEY is not set.');

  const body = {
    model:       req.model,
    messages:    req.messages,
    temperature: req.temperature,
    max_tokens:  req.maxTokens,
  };

  const res = await fetch(GROQ_API_URL, {
    method:  'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '(unreadable)');
    throw new LLMProviderError('Groq', res.status, text);
  }

  const data = await res.json() as any;
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