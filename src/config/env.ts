import dotenv from 'dotenv';
dotenv.config();

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function optionalEnv(name: string, fallback = ''): string {
  return process.env[name] ?? fallback;
}

export const env = {
  PORT:               optionalEnv('PORT', '3000'),
  SUPABASE_URL:       requireEnv('SUPABASE_URL'),
  SUPABASE_ANON_KEY:  requireEnv('SUPABASE_ANON_KEY'),
  SUPABASE_SERVICE_ROLE_KEY: requireEnv('SUPABASE_SERVICE_ROLE_KEY'),

  // LLM providers
  GROQ_API_KEY:             optionalEnv('GROQ_API_KEY'),
  MISTRAL_API_KEY:          optionalEnv('MISTRAL_API_KEY'),
  GOOGLE_AI_STUDIO_API_KEY: optionalEnv('GOOGLE_AI_STUDIO_API_KEY'),

  // Model configuration — primary/fallback pairs (agents use model-router)
  PRIMARY_INTENT_MODEL:          optionalEnv('PRIMARY_INTENT_MODEL',          'gemini-2.5-flash-lite'),
  FALLBACK_INTENT_MODEL:         optionalEnv('FALLBACK_INTENT_MODEL',         'mistral-small-2603'),
  PRIMARY_TRIAGE_MODEL:          optionalEnv('PRIMARY_TRIAGE_MODEL',          'gemini-2.5-flash-lite'),
  FALLBACK_TRIAGE_MODEL:         optionalEnv('FALLBACK_TRIAGE_MODEL',         'mistral-small-2603'),
  PRIMARY_RESPONSE_MODEL:        optionalEnv('PRIMARY_RESPONSE_MODEL',        'mistral-small-2603'),
  FALLBACK_RESPONSE_MODEL:       optionalEnv('FALLBACK_RESPONSE_MODEL',       'gemini-2.5-flash-lite'),
  PRIMARY_RAG_GENERATION_MODEL:
    optionalEnv('RAG_GENERATION_MODEL', '') ||
    optionalEnv('PRIMARY_RAG_GENERATION_MODEL', '') ||
    'mistral-small-2603',
  FALLBACK_RAG_GENERATION_MODEL: optionalEnv('FALLBACK_RAG_GENERATION_MODEL', 'gemini-2.5-flash-lite'),

  // Legacy single-model keys (backward compatibility; not used by agents after model-router)
  TRIAGE_MODEL:         optionalEnv('TRIAGE_MODEL',          'gemini-2.5-flash-lite'),
  RESPONSE_MODEL:       optionalEnv('RESPONSE_MODEL',        'mistral-small-2603'),
  RAG_GENERATION_MODEL: optionalEnv('RAG_GENERATION_MODEL',  'mistral-small-2603'),

  // Feature flags
  INTENT_USE_SIMPLE_ROUTING: optionalEnv('INTENT_USE_SIMPLE_ROUTING', 'true'),
  NODE_ENV:                  optionalEnv('NODE_ENV', 'development'),

  // RAG configuration
  KB_DOCS_PATH:       optionalEnv('KB_DOCS_PATH',       'docs/kb'),
  VECTOR_STORE_PATH:  optionalEnv('VECTOR_STORE_PATH',  'data/vector-store.db'),
  EMBEDDING_MODEL:    optionalEnv('EMBEDDING_MODEL',    'mistral-embed'),
  RAG_TOP_K:          optionalEnv('RAG_TOP_K',          '4'),
  RAG_SIMILARITY_THRESHOLD: optionalEnv('RAG_SIMILARITY_THRESHOLD', '0.55'),
};