// BoM Builder data layer (Phase 6): recipes (boms + bom_components) and
// production runs. Company-wide read; create/update restricted to
// admin/production server-side via RLS. Recording production always goes
// through the record_bom_production() RPC (see supabase/schema.sql) — the
// only way stock actually moves for a BoM, atomically, with the
// shortfall check enforced in the database, not just in this client.
import { supabase } from './api.js';

/** @param {any} [client] */
export async function fetchBoms(client = supabase) {
  if (!client) return [];
  const { data, error } = await client
    .from('boms')
    .select(
      '*, output_item:items(id, name, unit_of_measure), components:bom_components(id, component_item_id, quantity, component_item:items(id, name, unit_of_measure))'
    )
    .is('deleted_at', null)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data;
}

/**
 * @param {string} bomId
 * @param {any} [client]
 */
export async function fetchProductionRuns(bomId, client = supabase) {
  if (!client) return [];
  const { data, error } = await client
    .from('bom_production_runs')
    .select('*')
    .eq('bom_id', bomId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data;
}

/**
 * @param {{ outputItemId: string, outputQty: number, name?: string|null, notes?: string|null,
 *   components: { componentItemId: string, quantity: number }[], createdBy: string }} form
 * @param {any} [client]
 */
export async function createBom(form, client = supabase) {
  if (!client) throw new Error('Supabase is not configured.');
  const { data: bom, error: bomError } = await client
    .from('boms')
    .insert({
      output_item_id: form.outputItemId,
      output_qty: form.outputQty,
      name: form.name || null,
      notes: form.notes || null,
      created_by: form.createdBy,
    })
    .select()
    .single();
  if (bomError) throw bomError;

  const { error: componentsError } = await client.from('bom_components').insert(
    form.components.map((c) => ({ bom_id: bom.id, component_item_id: c.componentItemId, quantity: c.quantity }))
  );
  if (componentsError) throw componentsError;

  return bom;
}

/**
 * Replaces a BoM's header fields and its entire component set — editing a
 * recipe is "replace wholesale," not a per-row diff (see schema.sql).
 * @param {string} bomId
 * @param {{ outputQty: number, name?: string|null, notes?: string|null,
 *   components: { componentItemId: string, quantity: number }[] }} form
 * @param {any} [client]
 */
export async function updateBom(bomId, form, client = supabase) {
  if (!client) throw new Error('Supabase is not configured.');
  const { error: updateError } = await client
    .from('boms')
    .update({ output_qty: form.outputQty, name: form.name || null, notes: form.notes || null })
    .eq('id', bomId);
  if (updateError) throw updateError;

  const { error: deleteError } = await client.from('bom_components').delete().eq('bom_id', bomId);
  if (deleteError) throw deleteError;

  if (form.components.length > 0) {
    const { error: insertError } = await client
      .from('bom_components')
      .insert(form.components.map((c) => ({ bom_id: bomId, component_item_id: c.componentItemId, quantity: c.quantity })));
    if (insertError) throw insertError;
  }
}

/**
 * @param {string} bomId
 * @param {any} [client]
 */
export async function archiveBom(bomId, client = supabase) {
  if (!client) throw new Error('Supabase is not configured.');
  const { error } = await client.from('boms').update({ deleted_at: new Date().toISOString() }).eq('id', bomId);
  if (error) throw error;
}

/**
 * @param {string} bomId
 * @param {{ quantityProduced: number, notes?: string|null }} form
 * @param {any} [client]
 */
export async function recordBomProduction(bomId, form, client = supabase) {
  if (!client) throw new Error('Supabase is not configured.');
  const { data, error } = await client.rpc('record_bom_production', {
    target_bom_id: bomId,
    qty_produced: form.quantityProduced,
    notes_in: form.notes || null,
  });
  if (error) throw error;
  return data;
}
