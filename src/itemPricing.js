// Item pricing data layer (Phase 12): Rs. value of stock in hand needs a
// price per item, which items never had. Rates live in their own
// append-only ledger (item_price_history), never as a mutable column on
// items — the same "the ledger IS the record" discipline as
// stock_movements, so every past rate stays on record instead of being
// overwritten. item_current_rate/stock_valuation (both views, see
// supabase/schema.sql) do the "what's the latest one" and "what's it
// worth" math server-side. Insert-only for direct clients — same
// admin/purchase/store gate as items itself (can_manage_items), since
// setting a rate is an Item Master edit, not a stock movement.
import { supabase } from './api.js';

/** @param {any} [client] */
export async function fetchCurrentRates(client = supabase) {
  if (!client) return [];
  const { data, error } = await client.from('item_current_rate').select('*');
  if (error) throw error;
  return data;
}

/** @param {any} [client] */
export async function fetchStockValuation(client = supabase) {
  if (!client) return [];
  const { data, error } = await client.from('stock_valuation').select('*').order('name');
  if (error) throw error;
  return data;
}

/**
 * @param {{ itemId?: string, dateFrom?: string, dateTo?: string }} [filters]
 * @param {any} [client]
 */
export async function fetchPriceHistory(filters = {}, client = supabase) {
  if (!client) return [];
  let query = client
    .from('item_price_history')
    .select('*, item:items(id, name, unit_of_measure), created_by_user:users(id, name)')
    .order('effective_date', { ascending: false })
    .order('created_at', { ascending: false });

  if (filters.itemId) query = query.eq('item_id', filters.itemId);
  if (filters.dateFrom) query = query.gte('effective_date', filters.dateFrom);
  if (filters.dateTo) query = query.lte('effective_date', filters.dateTo);

  const { data, error } = await query;
  if (error) throw error;
  return data;
}

/**
 * Records a new rate for an item — used both the first time a rate is
 * ever set (optionally right after creating the item) and for every later
 * change. Never updates an existing row; the previous rate simply becomes
 * the second-most-recent entry in the history.
 * @param {{ itemId: string, rate: number, effectiveDate: string, createdBy: string }} form
 * @param {any} [client]
 */
export async function setItemRate(form, client = supabase) {
  if (!client) throw new Error('Supabase is not configured.');
  const { data, error } = await client
    .from('item_price_history')
    .insert({
      item_id: form.itemId,
      rate: form.rate,
      effective_date: form.effectiveDate,
      created_by: form.createdBy,
    })
    .select()
    .single();
  if (error) throw error;
  return data;
}
