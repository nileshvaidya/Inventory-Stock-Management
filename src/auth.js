// Session/profile helpers and the sign-in/sign-up/sign-out flows. Demo mode
// (src/demoMode.js) short-circuits everything here when active — it never
// touches Supabase.
import { supabase } from './api.js';
import { getDemoUser } from './demoMode.js';
import { validateSignupForm, validateSigninForm } from './validation.js';

/** @param {any} [client] injectable Supabase client, defaults to the real one — tests pass a fake */
export async function getSessionUser(client = supabase) {
  const demo = getDemoUser();
  if (demo) return demo;
  if (!client) return null;
  const { data } = await client.auth.getSession();
  return data.session ? data.session.user : null;
}

/** @param {any} [client] */
export async function getCurrentProfile(client = supabase) {
  const demo = getDemoUser();
  if (demo) return demo;
  const sessionUser = await getSessionUser(client);
  if (!sessionUser || !client) return null;
  const { data, error } = await client.from('users').select('*').eq('id', sessionUser.id).single();
  if (error) return null;
  return data;
}

/**
 * @param {{ name: string, email: string, password: string }} form
 * @param {any} [client]
 */
export async function signUp(form, client = supabase) {
  const { valid, errors } = validateSignupForm(form);
  if (!valid) return { data: null, error: { message: Object.values(errors)[0], errors } };
  if (!client) return { data: null, error: { message: 'Supabase is not configured.' } };

  const { name, email, password } = form;
  const { data: authData, error: authError } = await client.auth.signUp({ email, password });
  if (authError) return { data: null, error: authError };
  if (!authData.session) {
    return {
      data: null,
      error: {
        message:
          'Account created, but no session was returned — enable "Confirm email off" in ' +
          'Supabase Auth settings so sign-up can finish in one step (see supabase/README.md).',
      },
    };
  }

  // role is intentionally null here — Phase 1 adds Admin-driven role
  // assignment (see README.md's Phase 1 scope). Until then a signed-up
  // user can reach the dashboard shell but every module route below it is
  // a placeholder anyway.
  const { error: profileError } = await client.from('users').insert({
    id: authData.user.id,
    name,
    email,
    role: null,
  });
  if (profileError) return { data: null, error: profileError };

  return { data: authData, error: null };
}

/**
 * @param {{ email: string, password: string }} form
 * @param {any} [client]
 */
export async function signIn(form, client = supabase) {
  const { valid, errors } = validateSigninForm(form);
  if (!valid) return { data: null, error: { message: Object.values(errors)[0], errors } };
  if (!client) return { data: null, error: { message: 'Supabase is not configured.' } };

  const { email, password } = form;
  const { data: authData, error: authError } = await client.auth.signInWithPassword({ email, password });
  if (authError) return { data: null, error: authError };

  const { data: profile, error: profileError } = await client
    .from('users')
    .select('*')
    .eq('id', authData.user.id)
    .single();
  if (profileError) return { data: null, error: profileError };

  if (profile.status === 'inactive') {
    await client.auth.signOut();
    return {
      data: null,
      error: { message: 'This account is inactive. Contact your admin.', code: 'inactive_user' },
    };
  }

  return { data: profile, error: null };
}

/** @param {any} [client] */
export async function signOutUser(client = supabase) {
  if (!client) return;
  await client.auth.signOut();
}
