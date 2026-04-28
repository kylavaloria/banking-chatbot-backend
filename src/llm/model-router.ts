// ─────────────────────────────────────────────────────────────────────────────
// Model router — primary provider call with automatic fallback on retryable
// provider errors (503 / 429 / 404, overload, rate limit, etc.).
// ─────────────────────────────────────────────────────────────────────────────

import { callGemini } from './gemini.client';
import { callMistral } from './mistral.client';
import type { LLMRequest, LLMResponse } from './types';
import { LLMProviderError } from './types';

const GEMINI_MODELS = new Set([
  'gemini-2.5-flash-lite',
  'gemini-2.5-flash',
  'gemini-2.5-pro',
  'gemini-2.0-flash',
  'gemini-2.0-flash-lite',
]);

const MISTRAL_MODELS = new Set([
  'mistral-small-2603',
  'mistral-small-latest',
  'mistral-small-2506',
  'mistral-medium-latest',
  'mistral-large-latest',
  'open-mistral-7b',
  'open-mixtral-8x7b',
]);

function getClientForModel(model: string): (req: LLMRequest) => Promise<LLMResponse> {
  const lower = model.toLowerCase();
  if (lower.includes('gemini')) return callGemini;
  if (lower.includes('mistral') || lower.includes('mixtral') || lower.includes('codestral')) {
    return callMistral;
  }
  if (GEMINI_MODELS.has(model)) return callGemini;
  if (MISTRAL_MODELS.has(model)) return callMistral;
  console.warn(`[ModelRouter] Unknown model "${model}" — defaulting to Mistral client`);
  return callMistral;
}

function isRetryableError(err: unknown): boolean {
  if (err instanceof LLMProviderError) {
    return [429, 503, 404].includes(err.status);
  }
  if (err instanceof Error) {
    const msg = err.message.toLowerCase();
    return (
      msg.includes('503') ||
      msg.includes('429') ||
      msg.includes('404') ||
      msg.includes('high demand') ||
      msg.includes('rate limit') ||
      msg.includes('not found') ||
      msg.includes('overloaded') ||
      msg.includes('unavailable')
    );
  }
  return false;
}

export interface ModelRouterOptions {
  primaryModel:  string;
  fallbackModel: string;
  temperature:   number;
  maxTokens:     number;
  messages:      LLMRequest['messages'];
  agentName:     string;
}

export async function callWithFallback(opts: ModelRouterOptions): Promise<LLMResponse> {
  const primaryClient  = getClientForModel(opts.primaryModel);
  const fallbackClient = getClientForModel(opts.fallbackModel);

  const request: LLMRequest = {
    messages:    opts.messages,
    temperature: opts.temperature,
    maxTokens:   opts.maxTokens,
    model:       opts.primaryModel,
  };

  try {
    return await primaryClient(request);
  } catch (primaryErr) {
    if (isRetryableError(primaryErr)) {
      console.warn(
        `[ModelRouter] ${opts.agentName} primary model "${opts.primaryModel}" failed — ` +
          `falling back to "${opts.fallbackModel}". Reason: ` +
          (primaryErr instanceof Error ? primaryErr.message.slice(0, 120) : String(primaryErr))
      );
      return fallbackClient({ ...request, model: opts.fallbackModel });
    }
    throw primaryErr;
  }
}
