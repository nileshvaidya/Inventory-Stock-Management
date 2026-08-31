// Inventory data layer (Phase 4): current_stock view + the stock_movements
// ledger. Company-wide read; manual movement entries are store/admin only
// server-side via RLS — auto-created "in" movements from accepted
// inspections bypass this entirely (a security-definer trigger, see
// supabase/schema.sql), not something this data layer ever writes itself.
import { supabase } from './api.js';

/** @param {any} [client] */
export async function fetchCurrentStock(client = supabase) {
  if (!client) return [];
  const { data, error } = await client.from('current_stock').select('*').order('name');
  if (error) throw error;
  return data;
}

/**
 * current_stock netted against active Phase 7 work-order reservations —
 * current_qty minus reserved_qty. Inventory shows this instead of plain
 * current_stock so "available" (what's actually free to use) is visible
 * alongside on-hand quantity.
 * @param {any} [client]
 */
export async function fetchAvailableStock(client = supabase) {
  if (!client) return [];
  const { data, error } = await client.from('available_stock').select('*').order('name');
  if (error) throw error;
  return data;
}

/**
 * @param {string} itemId
 * @param {any} [client]
 */
export async function fetchMovementsForItem(itemId, client = supabase) {
  if (!client) return [];
  const { data, error } = await client
    .from('stock_movements')
    .select('*')
    .eq('item_id', itemId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data;
}

/**
 * @param {{ itemId: string, movementType: 'in'|'out', quantity: number, notes?: string|null, createdBy: string }} form
 * @param {any} [client]
 */
export async function createStockMovement(form, client = supabase) {
  if (!client) throw new Error('Supabase is not configured.');
  const { error } = await client.from('stock_movements').insert({
    item_id: form.itemId,
    movement_type: form.movementType,
    quantity: form.quantity,
    notes: form.notes || null,
    created_by: form.createdBy,
  });
  if (error) throw error;
}
