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

// The scanned delivery challan itself (direct user request, mirrors
// invoices.js's uploadBillFile/getBillFileUrl), stored in the private
// 'challan-documents' bucket (RLS: store/admin write, company-wide read —
// see supabase/schema.sql) rather than a text column, since a binary file
// needs Storage. Path is namespaced by inward id so re-uploads for
// different receipts can never collide.
const CHALLAN_BUCKET = 'challan-documents';

/**
 * @param {string} inwardId
 * @param {File} file
 * @param {any} [client]
 */
export async function uploadChallanFile(inwardId, file, client = supabase) {
  if (!client) throw new Error('Supabase is not configured.');
  const path = `${inwardId}/${Date.now()}-${file.name}`;
  const { error: uploadError } = await client.storage.from(CHALLAN_BUCKET).upload(path, file, { upsert: false });
  if (uploadError) throw uploadError;

  const { error: updateError } = await client
    .from('material_inward')
    .update({ challan_file_path: path, challan_file_name: file.name })
    .eq('id', inwardId);
  if (updateError) throw updateError;
}

/**
 * Signed URL, not getPublicUrl — the bucket is private, so a viewer needs a
 * time-limited signed link rather than a bare public one.
 * @param {string} path
 * @param {any} [client]
 */
export async function getChallanFileUrl(path, client = supabase) {
  if (!client || !path) return null;
  const { data, error } = await client.storage.from(CHALLAN_BUCKET).createSignedUrl(path, 300);
  if (error) throw error;
  return data?.signedUrl ?? null;
}
