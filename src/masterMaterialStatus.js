// Master Material Status data layer (Phase 3) — reads the
// master_material_status view (supabase/schema.sql), one row per PO line
// item. Company-wide read (RLS on this screen is a role-based route gate
// in navPermissions.js, not a data restriction — every relevant role sees
// the same rows).
import { supabase } from './api.js';

/**
 * @param {{ projectId?: string, status?: string }} [filters]
 * @param {any} [client]
 */
export async function fetchMasterMaterialStatus(filters = {}, client = supabase) {
  if (!client) return [];
  let query = client.from('master_material_status').select('*').order('order_date', { ascending: false });
  if (filters.projectId) query = query.eq('project_id', filters.projectId);
  if (filters.status) query = query.eq('po_status', filters.status);

  const { data, error } = await query;
  if (error) throw error;
  return data;
}
