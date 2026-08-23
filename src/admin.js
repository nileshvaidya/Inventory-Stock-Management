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
  if (error) return { data: null, error: { message: error.message } };
  if (data?.error) return { data: null, error: { message: data.error } };
  return { data, error: null };
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
