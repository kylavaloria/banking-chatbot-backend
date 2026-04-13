// ─────────────────────────────────────────────────────────────────────────────
// Gemini HTTP client — Intent Agent, Triage Agent, RAG Generator
// Uses Google AI Studio REST API.
// Free tier: 1M TPM on gemini-2.0-flash
// Implements the same LLMRequest / LLMResponse interface as groq.client.ts
// ─────────────────────────────────────────────────────────────────────────────

import { env }                          from '../config/env';
import type { LLMRequest, LLMResponse } from './types';
import { LLMProviderError }             from './types';

const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

const MAX_RETRY_WAIT = 60_000;

function parseGeminiRetryAfterMs(body: string): number | null {
  try {
    const parsed  = JSON.parse(body);
    const details = parsed?.error?.details ?? [];
    for (const detail of details) {
      if (detail?.retryDelay) {
        const match = (detail.retryDelay as string).match(/^([\d.]+)s$/);
        if (match) return Math.ceil(parseFloat(match[1]) * 1000);
      }
    }
  } catch {
    const match = body.match(/"retryDelay"\s*:\s*"([\d.]+)s"/);
    if (match) return Math.ceil(parseFloat(match[1]) * 1000);
  }
  return null;
}

async function doGeminiRequest(url: string, body: object): Promise<Response> {
  return fetch(url, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  });
}

export async function callGemini(req: LLMRequest): Promise<LLMResponse> {
  const apiKey = env.GOOGLE_AI_STUDIO_API_KEY;
  if (!apiKey) throw new Error('GOOGLE_AI_STUDIO_API_KEY is not set.');

  const url = `${GEMINI_API_BASE}/${req.model}:generateContent?key=${apiKey}`;

  const systemMsg = req.messages.find(m => m.role === 'system');
  const userMsgs  = req.messages.filter(m => m.role !== 'system');

  const contents = userMsgs.map(m => ({
    role:  m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));

  const requestBody: Record<string, unknown> = {
    contents,
    generationConfig: {
      temperature:     req.temperature,
      maxOutputTokens: req.maxTokens,
    },
  };

  if (systemMsg) {
    requestBody['systemInstruction'] = {
      parts: [{ text: systemMsg.content }],
    };
  }

  let res = await doGeminiRequest(url, requestBody);

  if (res.status === 429) {
    const rawText      = await res.text();
    const retryAfterMs = parseGeminiRetryAfterMs(rawText);

    if (retryAfterMs !== null && retryAfterMs <= MAX_RETRY_WAIT) {
      console.warn(
        `[Gemini] Rate limited — waiting ${retryAfterMs}ms before retry (model: ${req.model})`
      );
      await new Promise(r => setTimeout(r, retryAfterMs + 500));
      res = await doGeminiRequest(url, requestBody);
    }

    if (res.status === 429) {
      const secondBody = await res.text().catch(() => rawText);
      throw new LLMProviderError('Gemini', 429, secondBody);
    }
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '(unreadable)');
    throw new LLMProviderError('Gemini', res.status, text);
  }

  const data = await res.json() as any;
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? '';

  if (!text) {
    throw new LLMProviderError('Gemini', 200, 'Empty content in response');
  }

  return {
    text,
    model_used: req.model,
    usage: {
      prompt_tokens:     data?.usageMetadata?.promptTokenCount     ?? 0,
      completion_tokens: data?.usageMetadata?.candidatesTokenCount ?? 0,
    },
  };
}