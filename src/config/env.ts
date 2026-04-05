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

  // Slice 4: LLM providers
  GROQ_API_KEY:            optionalEnv('GROQ_API_KEY'),
  RESPONSE_MODEL:       optionalEnv('RESPONSE_MODEL',        'mistral-small-2506'),

  // Model configuration
  PRIMARY_INTENT_MODEL: optionalEnv('PRIMARY_INTENT_MODEL', 'llama-3.3-70b-versatile'),
  FALLBACK_INTENT_MODEL:optionalEnv('FALLBACK_INTENT_MODEL', 'llama-3.1-8b-instant'),
  TRIAGE_MODEL:         optionalEnv('TRIAGE_MODEL',          'llama-3.1-8b-instant'),
  MISTRAL_API_KEY:      optionalEnv('MISTRAL_API_KEY'),

  // Feature flags
  INTENT_USE_SIMPLE_ROUTING: optionalEnv('INTENT_USE_SIMPLE_ROUTING', 'true'),
  NODE_ENV:                  optionalEnv('NODE_ENV', 'development'),
};