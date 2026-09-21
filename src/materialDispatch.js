// Material Dispatch data layer (Phase 11): dispatching material out —
// deducts inventory only once an admin authorizes the record (via
// authorize_material_dispatch(), the only path that both flips it to
// authorized and writes the resulting stock movements — see
// supabase/schema.sql). Store/admin only for creating a dispatch record
// and attaching its scanned delivery challan; admin only for authorizing
// and marking payment received. Every write beyond the initial create
// goes through a security-definer RPC, not a plain table update — the
// table itself has no update policy at all.
import { supabase } from './api.js';
import { getChallanFileUrl } from './materialInward.js';

// Reuses Material Inward's private 'challan-documents' Storage bucket
// (same kind of document, same access shape) — its own re-export here
// under a dispatch-specific name since the bucket read is bucket-scoped,
// not table-scoped, so the exact same signed-url helper works unchanged.
export const getDispatchChallanFileUrl = getChallanFileUrl;

const CHALLAN_BUCKET = 'challan-documents';

/** @param {any} [client] */
export async function fetchMaterialDispatches(client = supabase) {
  if (!client) return [];
  const { data, error } = await client
    .from('material_dispatch')
    .select('*, line_items:material_dispatch_line_items(*, item:items(id, name, unit_of_measure))')
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data;
}

/**
 * Sum of quantity x rate across a dispatch's line items — the pre-tax
 * Total Amount shown on both Material Dispatch and Delivery Challans.
 * Always derived from the current line items rather than stored, same as
 * every other computed total in this app (e.g. Stock Statement's).
 * @param {{ line_items?: { quantity: number, rate: number|null }[] }} dispatch
 */
export function dispatchTotalAmount(dispatch) {
  return (dispatch.line_items || []).reduce((sum, li) => sum + Number(li.quantity) * Number(li.rate || 0), 0);
}

/**
 * Total Amount with GST added — the Final Amount column on both
 * screens. A dispatch with no gst_percent recorded (nullable — see
 * schema.sql's own comment on this column) is treated as 0% GST rather
 * than assuming today's default, so a pre-GST historical record's Final
 * Amount just equals its Total Amount.
 * @param {{ line_items?: { quantity: number, rate: number|null }[], gst_percent?: number|null }} dispatch
 */
export function dispatchFinalAmount(dispatch) {
  const total = dispatchTotalAmount(dispatch);
  const gstPercent = Number(dispatch.gst_percent || 0);
  return total * (1 + gstPercent / 100);
}

/**
 * Two-step insert (dispatch header, then its line items) — same
 * no-nested-insert caveat as createInward in materialInward.js. Creating
 * a dispatch never moves stock by itself; only authorizing it does.
 * clientPoNumber is only ever actually persisted when the caller is
 * admin — schema.sql's insert policy enforces this server-side too, so a
 * non-admin passing one here (there's no UI path that does) is silently
 * rejected by RLS rather than relying on the client to have hidden it.
 * @param {{ dispatchDate: string, dcNumber?: string|null, party?: string|null, notes?: string|null,
 *   clientPoNumber?: string|null, ourInvoiceNumber?: string|null, gstPercent?: string|number|null, createdBy: string,
 *   lineItems: { itemId: string, quantity: number, rate: number }[] }} form
 * @param {any} [client]
 */
export async function createMaterialDispatch(form, client = supabase) {
  if (!client) throw new Error('Supabase is not configured.');

  const { data: dispatch, error: dispatchError } = await client
    .from('material_dispatch')
    .insert({
      dispatch_date: form.dispatchDate,
      dc_number: form.dcNumber || null,
      reference: form.party || null,
      notes: form.notes || null,
      client_po_number: form.clientPoNumber || null,
      our_invoice_number: form.ourInvoiceNumber || null,
      gst_percent: form.gstPercent === '' || form.gstPercent === null || form.gstPercent === undefined ? null : Number(form.gstPercent),
      created_by: form.createdBy,
    })
    .select()
    .single();
  if (dispatchError) throw dispatchError;

  const rows = form.lineItems
    .filter((li) => Number(li.quantity) > 0)
    .map((li) => ({ dispatch_id: dispatch.id, item_id: li.itemId, quantity: Number(li.quantity), rate: Number(li.rate) }));

  if (rows.length > 0) {
    const { error: itemsError } = await client.from('material_dispatch_line_items').insert(rows);
    if (itemsError) throw itemsError;
  }

  return dispatch;
}

/**
 * Admin only, server-side. Sets/edits the client PO number and/or "our"
 * invoice number on an existing dispatch — the one edit path this table
 * has beyond its initial insert, alongside authorize/payment below (see
 * this file's own top comment on the no-update-policy discipline).
 * @param {string} dispatchId
 * @param {{ clientPoNumber?: string|null, ourInvoiceNumber?: string|null }} form
 * @param {any} [client]
 */
export async function updateDispatchBilling(dispatchId, form, client = supabase) {
  if (!client) throw new Error('Supabase is not configured.');
  const { data, error } = await client.rpc('admin_update_dispatch_billing', {
    target_dispatch_id: dispatchId,
    po_number_in: form.clientPoNumber || null,
    invoice_number_in: form.ourInvoiceNumber || null,
  });
  if (error) throw error;
  return data;
}

/**
 * @param {string} dispatchId
 * @param {File} file
 * @param {any} [client]
 */
export async function uploadDispatchChallanFile(dispatchId, file, client = supabase) {
  if (!client) throw new Error('Supabase is not configured.');
  const path = `${dispatchId}/${Date.now()}-${file.name}`;
  const { error: uploadError } = await client.storage.from(CHALLAN_BUCKET).upload(path, file, { upsert: false });
  if (uploadError) throw uploadError;

  const { error: attachError } = await client.rpc('attach_dispatch_challan_file', {
    target_dispatch_id: dispatchId,
    file_path_in: path,
    file_name_in: file.name,
  });
  if (attachError) throw attachError;
}

/**
 * Admin only, server-side. Deducts every line item's quantity from
 * inventory atomically — blocked entirely if any item is short.
 * @param {string} dispatchId
 * @param {any} [client]
 */
export async function authorizeMaterialDispatch(dispatchId, client = supabase) {
  if (!client) throw new Error('Supabase is not configured.');
  const { data, error } = await client.rpc('authorize_material_dispatch', { target_dispatch_id: dispatchId });
  if (error) throw error;
  return data;
}

/**
 * Admin only, server-side. No stock side effect — just records that
 * payment for this dispatch has come in, on the date the admin says it
 * actually did (not assumed to be "today").
 * @param {string} dispatchId
 * @param {string} paymentDate
 * @param {any} [client]
 */
export async function markDispatchPaymentReceived(dispatchId, paymentDate, client = supabase) {
  if (!client) throw new Error('Supabase is not configured.');
  const { data, error } = await client.rpc('mark_dispatch_payment_received', {
    target_dispatch_id: dispatchId,
    payment_date_in: paymentDate,
  });
  if (error) throw error;
  return data;
}
