// Inspection data layer (Phase 3). Inspector/admin only for writes
// (RLS-enforced server-side); reads scoped to this screen's own role gate.
import { supabase } from './api.js';

/**
 * Received line items with no inspection record yet — inspection_results
 * is unique per inward line item (P3: one inspection pass disposes all of
 * a receipt line's quantity), so "pending" is simply "no row exists yet".
 * PostgREST can't filter on a nested-embed's absence directly, so this
 * over-fetches and filters client-side, same tradeoff as other screens
 * that compute totals in JS rather than a bespoke query per case.
 * @param {any} [client]
 */
export async function fetchPendingInspection(client = supabase) {
  if (!client) return [];
  const { data, error } = await client.from('material_inward_line_items').select(`
      *,
      po_line_item:po_line_items(item_name, po:purchase_orders(id, po_number, project:projects(name))),
      inward:material_inward(received_date, deleted_at),
      inspection_results(id)
    `);
  if (error) throw error;
  return (data ?? []).filter((row) => !row.inward?.deleted_at && (row.inspection_results ?? []).length === 0);
}

/**
 * @param {{ inwardLineItemId: string, acceptedQty: number, rejectedQty: number,
 *   rejectionReason?: string|null, inspectedBy: string }} form
 * @param {any} [client]
 */
export async function recordInspection(form, client = supabase) {
  if (!client) throw new Error('Supabase is not configured.');
  const { error } = await client.from('inspection_results').insert({
    inward_line_item_id: form.inwardLineItemId,
    accepted_qty: form.acceptedQty,
    rejected_qty: form.rejectedQty,
    rejection_reason: form.rejectionReason || null,
    inspected_by: form.inspectedBy,
  });
  if (error) throw error;
}
