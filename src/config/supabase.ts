import { createClient } from '@supabase/supabase-js';
import { env } from './env';

// Used only for JWT verification (auth.getUser).
// Respects RLS — do NOT use this for DB writes.
export const anonClient = createClient(
  env.SUPABASE_URL,
  env.SUPABASE_ANON_KEY
);

// Used for all database operations from the backend.
// Bypasses RLS. Never expose this key to the frontend.
export const serviceClient = createClient(
  env.SUPABASE_URL,
  env.SUPABASE_SERVICE_ROLE_KEY,
  {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  }
);