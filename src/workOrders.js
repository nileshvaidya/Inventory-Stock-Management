// Work Orders data layer (Phase 7): nested BoM explosion + hard stock
// reservation. Every write (create, reserve) goes through a
// security-definer RPC — explosion/netting and the atomic
// re-availability check can't safely happen as a plain client insert —
// only cancelling is a plain table update, gated by RLS the same way
// Phase 6's archive is.
import { supabase } from './api.js';

/** @param {any} [client] */
export async function fetchWorkOrders(client = supabase) {
  if (!client) return [];
  const { data, error } = await client
    .from('work_orders')
    .select('*, output_item:items(id, name, unit_of_measure)')
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data;
}

/**
 * @param {string} workOrderId
 * @param {any} [client]
 */
export async function fetchWorkOrderRequirements(workOrderId, client = supabase) {
  if (!client) return [];
  const { data, error } = await client
    .from('work_order_requirements')
    .select('*, item:items(id, name, unit_of_measure)')
    .eq('work_order_id', workOrderId);
  if (error) throw error;
  return data;
}

/**
 * A live, read-only preview of what creating a work order for this
 * item/quantity would require — the same explosion create_work_order()
 * runs, called ahead of time so the form can show it before saving.
 * @param {string} itemId
 * @param {number} qty
 * @param {any} [client]
 */
export async function previewExplosion(itemId, qty, client = supabase) {
  if (!client) return [];
  const { data, error } = await client.rpc('explode_bom_requirements', { root_item_id: itemId, root_qty: qty });
  if (error) throw error;
  return data;
}

/**
 * @param {{ outputItemId: string, quantity: number, notes?: string|null }} form
 * @param {any} [client]
 */
export async function createWorkOrder(form, client = supabase) {
  if (!client) throw new Error('Supabase is not configured.');
  const { data, error } = await client.rpc('create_work_order', {
    target_output_item_id: form.outputItemId,
    target_qty: form.quantity,
    notes_in: form.notes || null,
  });
  if (error) throw error;
  return data;
}

/**
 * @param {string} workOrderId
 * @param {any} [client]
 */
export async function reserveWorkOrder(workOrderId, client = supabase) {
  if (!client) throw new Error('Supabase is not configured.');
  const { data, error } = await client.rpc('reserve_work_order', { target_work_order_id: workOrderId });
  if (error) throw error;
  return data;
}

/**
 * @param {string} workOrderId
 * @param {any} [client]
 */
export async function cancelWorkOrder(workOrderId, client = supabase) {
  if (!client) throw new Error('Supabase is not configured.');
  const { error } = await client.from('work_orders').update({ status: 'cancelled' }).eq('id', workOrderId);
  if (error) throw error;
}
