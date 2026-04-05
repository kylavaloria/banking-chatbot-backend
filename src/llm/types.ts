// ─────────────────────────────────────────────────────────────────────────────
// LLM abstraction types
// Minimal shared interface so Groq and Gemini clients are swappable.
// ─────────────────────────────────────────────────────────────────────────────

export interface LLMMessage {
  role:    'system' | 'user' | 'assistant';
  content: string;
}

export interface LLMRequest {
  messages:    LLMMessage[];
  model:       string;
  temperature: number;
  /** Max tokens to generate */
  maxTokens:   number;
}

export interface LLMResponse {
  text:       string;
  model_used: string;
  /** Token counts for debugging */
  usage?: {
    prompt_tokens:     number;
    completion_tokens: number;
  };
}

/** Thrown when the provider returns a non-2xx status */
export class LLMProviderError extends Error {
  constructor(
    public provider: string,
    public status:   number,
    message:         string
  ) {
    super(`[${provider}] HTTP ${status}: ${message}`);
    this.name = 'LLMProviderError';
  }
}