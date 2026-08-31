// Reports (Phase 8) data layer. Entirely read-only, and entirely built on
// tables/views that already exist and are already company-wide readable
// (available_stock from Phase 4/7, stock_reservations/work_orders/
// work_order_requirements from Phase 7) — no new schema, no new RLS,
// nothing for scripts/test-rls-*.mjs to add.
import { supabase } from './api.js';

/**
 * Every active (work order status = 'reserved') stock reservation, with
 * the reserved item and the work order (and what it's producing)
 * embedded — the detail behind Reports' Stock & Reservations tab.
 * @param {any} [client]
 */
export async function fetchActiveReservations(client = supabase) {
  if (!client) return [];
  const { data, error } = await client
    .from('stock_reservations')
    .select('*, item:items(id, name, unit_of_measure), work_order:work_orders!inner(id, quantity, status, output_item:items(id, name))')
    .eq('work_order.status', 'reserved')
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data;
}

/**
 * Every component still short somewhere in an open or reserved work
 * order's exploded requirements — items that need procurement or
 * production outside what's already planned.
 * @param {any} [client]
 */
export async function fetchShortages(client = supabase) {
  if (!client) return [];
  const { data, error } = await client
    .from('work_order_requirements')
    .select('*, item:items(id, name, unit_of_measure), work_order:work_orders!inner(id, quantity, status, output_item:items(id, name))')
    .gt('shortfall_qty', 0)
    .in('work_order.status', ['open', 'reserved'])
    .order('shortfall_qty', { ascending: false });
  if (error) throw error;
  return data;
}
