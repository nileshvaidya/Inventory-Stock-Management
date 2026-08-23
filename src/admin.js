// User & Role Management (Phase 1) data layer — thin wrappers around the
// security-definer RPCs in supabase/schema.sql and the admin-invite-user
// Edge Function. Every function here is a no-op (throws or returns an
// error) for a non-admin caller — enforced server-side (is_admin() inside
// each RPC/function), not just by the UI hiding the Users & Roles screen.
import { supabase } from './api.js';

/** @param {any} [client] */
export async function fetchAdminUsers(client = supabase) {
  if (!client) return [];
  const { data, error } = await client.rpc('admin_list_users');
  if (error) throw error;
  return data;
}

/**
 * Calls the admin-invite-user Edge Function (needs the service-role key,
 * so it can't run as a plain client-side insert — see supabase/README.md).
 * @param {{ name: string, email: string, role: string|null }} form
 * @param {any} [client]
 */
export async function inviteUser(form, client = supabase) {
  if (!client) return { data: null, error: { message: 'Supabase is not configured.' } };
  const { data: sessionData } = await client.auth.getSession();
  const token = sessionData?.session?.access_token;
  if (!token) return { data: null, error: { message: 'Not signed in.' } };

  const { data, error } = await client.functions.invoke('admin-invite-user', {
    body: form,
    headers: { Authorization: `Bearer ${token}` },
  });
  if (error) return { data: null, error: { message: await extractFunctionErrorMessage(error) } };
  if (data?.error) return { data: null, error: { message: data.error } };
  return { data, error: null };
}

/**
 * The Supabase JS client's `functions.invoke()` doesn't surface the actual
 * JSON body a non-2xx Edge Function response returned — `error.message` is
 * just a generic "Edge Function returned a non-2xx status code". The real
 * reason (e.g. "Only an admin can invite users.") is on `error.context`,
 * the raw fetch Response, and has to be read out by hand.
 * @param {any} error
 */
async function extractFunctionErrorMessage(error) {
  try {
    const body = await error.context?.json();
    if (body?.error) return body.error;
  } catch {
    // context wasn't JSON (e.g. a network-level failure with no response
    // body at all) — fall through to the generic SDK message below.
  }
  return error.message || 'Could not send the invite.';
}

/**
 * @param {string} targetId
 * @param {string|null} newRole
 * @param {any} [client]
 */
export async function setUserRole(targetId, newRole, client = supabase) {
  if (!client) throw new Error('Supabase is not configured.');
  const { data, error } = await client.rpc('set_user_role', { target_id: targetId, new_role: newRole });
  if (error) throw error;
  return data;
}

/**
 * @param {string} targetId
 * @param {'active'|'inactive'} newStatus
 * @param {any} [client]
 */
export async function setUserStatus(targetId, newStatus, client = supabase) {
  if (!client) throw new Error('Supabase is not configured.');
  const { data, error } = await client.rpc('set_user_status', { target_id: targetId, new_status: newStatus });
  if (error) throw error;
  return data;
}
