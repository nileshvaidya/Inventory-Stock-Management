// Item Master data layer (Phase 4). Company-wide read; create/update
// restricted to purchase/store/admin server-side via RLS — PO Upload and
// the Inventory screen both create items through this same function.
import { supabase } from './api.js';

/** @param {any} [client] */
export async function fetchItems(client = supabase) {
  if (!client) return [];
  const { data, error } = await client.from('items').select('*').is('deleted_at', null).order('name');
  if (error) throw error;
  return data;
}

/**
 * @param {{ name: string, category?: string|null, unitOfMeasure?: string|null, reorderLevel?: number|null }} form
 * @param {any} [client]
 */
export async function createItem(form, client = supabase) {
  if (!client) throw new Error('Supabase is not configured.');
  const { data, error } = await client
    .from('items')
    .insert({
      name: form.name,
      category: form.category || null,
      unit_of_measure: form.unitOfMeasure || null,
      reorder_level: form.reorderLevel ?? null,
    })
    .select()
    .single();
  if (error) throw error;
  return data;
}
