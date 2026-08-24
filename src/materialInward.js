// Material Inward data layer (Phase 3). Store/admin only for writes
// (RLS-enforced server-side, not just hidden client-side); reads scoped to
// this screen's own role gate (navPermissions.js), not company-wide.
import { supabase } from './api.js';

/**
 * POs still eligible to receive against — not yet fully received.
 * @param {any} [client]
 */
export async function fetchReceivableOrders(client = supabase) {
  if (!client) return [];
  const { data, error } = await client
    .from('purchase_orders')
    .select('*, project:projects(id, name), vendor:vendors(id, name)')
    .in('status', ['to_be_received', 'partially_received'])
    .is('deleted_at', null)
    .order('order_date', { ascending: false });
  if (error) throw error;
  return data;
}

/**
 * Per-line-item Ordered/Received/Pending for one PO, via the
 * master_material_status view — the same source Master Material Status
 * itself reads, so "already received" here can never disagree with it.
 * @param {string} poId
 * @param {any} [client]
 */
export async function fetchLineItemStatusForPo(poId, client = supabase) {
  if (!client) return [];
  const { data, error } = await client.from('master_material_status').select('*').eq('po_id', poId);
  if (error) throw error;
  return data;
}

/**
 * Two-step insert (inward header, then its line items) — same no-nested-
 * insert caveat as createPurchaseOrder in purchaseOrders.js.
 * @param {{ poId: string, receivedDate: string, notes?: string|null, receivedBy: string,
 *   lineItems: { poLineItemId: string, receivedQty: number }[] }} form
 * @param {any} [client]
 */
export async function createInward(form, client = supabase) {
  if (!client) throw new Error('Supabase is not configured.');

  const { data: inward, error: inwardError } = await client
    .from('material_inward')
    .insert({
      po_id: form.poId,
      received_date: form.receivedDate,
      notes: form.notes || null,
      received_by: form.receivedBy,
    })
    .select()
    .single();
  if (inwardError) throw inwardError;

  const rows = form.lineItems
    .filter((li) => Number(li.receivedQty) > 0)
    .map((li) => ({
      inward_id: inward.id,
      po_line_item_id: li.poLineItemId,
      received_qty: Number(li.receivedQty),
    }));

  if (rows.length > 0) {
    const { error: itemsError } = await client.from('material_inward_line_items').insert(rows);
    if (itemsError) throw itemsError;
  }

  return inward;
}

/**
 * @param {string} poId
 * @param {any} [client]
 */
export async function fetchInwardHistory(poId, client = supabase) {
  if (!client) return [];
  const { data, error } = await client
    .from('material_inward')
    .select('*, line_items:material_inward_line_items(*, po_line_item:po_line_items(item_name))')
    .eq('po_id', poId)
    .is('deleted_at', null)
    .order('received_date', { ascending: false });
  if (error) throw error;
  return data;
}
