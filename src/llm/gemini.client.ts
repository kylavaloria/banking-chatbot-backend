// ─────────────────────────────────────────────────────────────────────────────
// Gemini Flash HTTP client
// Used for Response Agent.
// Calls the Google AI Studio generateContent endpoint.
// ─────────────────────────────────────────────────────────────────────────────

import { env }                          from '../config/env';
import type { LLMRequest, LLMResponse } from './types';
import { LLMProviderError }             from './types';

function geminiUrl(model: string, apiKey: string): string {
  return `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
}

export async function callGemini(req: LLMRequest): Promise<LLMResponse> {
  const apiKey = env.GOOGLE_AI_STUDIO_API_KEY;
  if (!apiKey) throw new Error('GOOGLE_AI_STUDIO_API_KEY is not set.');

  // Gemini expects a single "contents" array — merge system prompt into first user turn
  const systemMsg = req.messages.find(m => m.role === 'system');
  const userMsgs  = req.messages.filter(m => m.role !== 'system');

  const contents = userMsgs.map(m => ({
    role:  m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));

  // Prepend system instruction as a user part if present
  if (systemMsg && contents.length > 0) {
    contents[0].parts.unshift({ text: `[System context]\n${systemMsg.content}\n\n` });
  }

  const body = {
    contents,
    generationConfig: {
      temperature:     req.temperature,
      maxOutputTokens: req.maxTokens,
    },
  };

  const res = await fetch(geminiUrl(req.model, apiKey), {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '(unreadable)');
    throw new LLMProviderError('Gemini', res.status, text);
  }

  const data = await res.json() as any;
  const candidate = data?.candidates?.[0];
  const text      = candidate?.content?.parts?.[0]?.text ?? '';

  if (!text) throw new LLMProviderError('Gemini', 200, 'Empty text in response');

  return {
    text,
    model_used: req.model,
    usage: {
      prompt_tokens:     data.usageMetadata?.promptTokenCount     ?? 0,
      completion_tokens: data.usageMetadata?.candidatesTokenCount ?? 0,
    },
  };
}