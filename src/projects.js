// Projects/Orders data layer (Phase 2). Company-wide read; create is
// restricted to admin/purchase server-side via RLS (supabase/schema.sql),
// not just hidden in the UI.
import { supabase } from './api.js';

/** @param {any} [client] */
export async function fetchProjects(client = supabase) {
  if (!client) return [];
  const { data, error } = await client.from('projects').select('*').is('deleted_at', null).order('name');
  if (error) throw error;
  return data;
}

/**
 * @param {string} name
 * @param {any} [client]
 */
export async function createProject(name, client = supabase) {
  if (!client) throw new Error('Supabase is not configured.');
  const { data, error } = await client.from('projects').insert({ name }).select().single();
  if (error) throw error;
  return data;
}
