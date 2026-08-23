// Supabase client wiring. Reads Vite-exposed env vars (must be prefixed
// VITE_ to reach the client bundle) and fails with a readable error rather
// than a cryptic downstream failure when they're missing.
import { createClient } from '@supabase/supabase-js';

/**
 * @param {Record<string, string | undefined>} [env]
 */
export function createSupabaseClient(env = import.meta.env) {
  const url = env.VITE_SUPABASE_URL;
  const anonKey = env.VITE_SUPABASE_ANON_KEY;

  if (!url || !anonKey) {
    throw new Error(
      'Missing VITE_SUPABASE_URL and/or VITE_SUPABASE_ANON_KEY. ' +
        'Set them in a local .env file (see .env.example) or in your deployment ' +
        "platform's environment variables before running the app."
    );
  }

  return createClient(url, anonKey);
}

let client = null;
try {
  client = createSupabaseClient();
} catch (err) {
  console.error(err.message);
}

export const supabase = client;
