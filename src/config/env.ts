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

  // Model configuration
  PRIMARY_INTENT_MODEL: optionalEnv('PRIMARY_INTENT_MODEL', 'llama-3.3-70b-versatile'),
  FALLBACK_INTENT_MODEL:optionalEnv('FALLBACK_INTENT_MODEL', 'llama-3.1-8b-instant'),
  TRIAGE_MODEL:         optionalEnv('TRIAGE_MODEL',          'llama-3.3-70b-versatile'),
  RESPONSE_MODEL:       optionalEnv('RESPONSE_MODEL',        'mistral-small-2506'),
  RAG_GENERATION_MODEL: optionalEnv('RAG_GENERATION_MODEL',  'llama-3.1-8b-instant'),

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