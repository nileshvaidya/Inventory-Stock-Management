// Material Dispatch data layer (Phase 11): dispatching material out —
// deducts inventory only once an admin authorizes the record (via
// authorize_material_dispatch(), the only path that both flips it to
// authorized and writes the resulting stock movements — see
// supabase/schema.sql). Store/admin only for creating a dispatch record
// and attaching its scanned delivery challan; admin only for authorizing
// and marking payment received. Every write beyond the initial create
// goes through a security-definer RPC, not a plain table update — the
// table itself has no update policy at all.
//
// Addendum (direct request): double-clicking an unauthorized dispatch on
// Material Dispatch opens it for editing in place — see
// updateMaterialDispatch below and the double-click wiring in
// screens/materialDispatch.js. Only while unauthorized: once authorized,
// its line items are already reflected in real stock movements, so
// editing them further is blocked server-side rather than risking
// inventory drifting out of sync with what was actually recorded.
import { supabase } from './api.js';
import { getChallanFileUrl } from './materialInward.js';

// Reuses Material Inward's private 'challan-documents' Storage bucket
// (same kind of document, same access shape) — its own re-export here
// under a dispatch-specific name since the bucket read is bucket-scoped,
// not table-scoped, so the exact same signed-url helper works unchanged.
export const getDispatchChallanFileUrl = getChallanFileUrl;

const CHALLAN_BUCKET = 'challan-documents';

/**
 * filters is optional and defaults to none, so Material Dispatch's own
 * unfiltered list (which never passes any) is unaffected — only Delivery
 * Challans (Phase 13, third addendum, direct request) actually filters.
 * status mirrors the three states both screens display: 'pending_
 * authorization' (authorized_at is null — not billable yet, so it's
 * excluded from Delivery Challans' Pending Dues/Total Amount Received
 * the same way it's excluded from ever showing a payment status),
 * 'pending' (authorized but payment_received_at is null), and 'paid'
 * (payment_received_at is not null) — none of these is a stored column,
 * so each is its own combination of `.is()`/`.not()` filters rather than
 * a plain `.eq()`.
 * @param {{ dateFrom?: string, dateTo?: string, poNumber?: string, status?: string }} [filters]
 * @param {any} [client]
 */
export async function fetchMaterialDispatches(filters = {}, client = supabase) {
  if (!client) return [];
  let query = client
    .from('material_dispatch')
    .select('*, line_items:material_dispatch_line_items(*, item:items(id, name, unit_of_measure))')
    .order('created_at', { ascending: false });

  if (filters.dateFrom) query = query.gte('dispatch_date', filters.dateFrom);
  if (filters.dateTo) query = query.lte('dispatch_date', filters.dateTo);
  if (filters.poNumber) query = query.ilike('client_po_number', `%${filters.poNumber}%`);
  if (filters.status === 'pending_authorization') query = query.is('authorized_at', null);
  if (filters.status === 'pending') query = query.not('authorized_at', 'is', null).is('payment_received_at', null);
  if (filters.status === 'paid') query = query.not('payment_received_at', 'is', null);

  const { data, error } = await query;
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
 * Store/admin, server-side — same role as creating a dispatch, since this
 * is really "fix a mistake before it's committed": edits every field a
 * new dispatch has, including its line items, but only while the
 * dispatch is still unauthorized (the RPC itself rejects an authorized
 * one — see update_material_dispatch() in supabase/schema.sql). A
 * non-admin's clientPoNumber is ignored server-side rather than trusted,
 * same restriction as this table's own insert policy; this screen's own
 * edit form never even sends one for a non-admin (see
 * screens/materialDispatch.js).
 * @param {string} dispatchId
 * @param {{ dispatchDate: string, dcNumber?: string|null, party?: string|null, notes?: string|null,
 *   clientPoNumber?: string|null, ourInvoiceNumber?: string|null, gstPercent?: string|number|null,
 *   lineItems: { itemId: string, quantity: number, rate: number }[] }} form
 * @param {any} [client]
 */
export async function updateMaterialDispatch(dispatchId, form, client = supabase) {
  if (!client) throw new Error('Supabase is not configured.');
  const { data, error } = await client.rpc('update_material_dispatch', {
    target_dispatch_id: dispatchId,
    dispatch_date_in: form.dispatchDate,
    dc_number_in: form.dcNumber || null,
    reference_in: form.party || null,
    our_invoice_number_in: form.ourInvoiceNumber || null,
    client_po_number_in: form.clientPoNumber || null,
    gst_percent_in: form.gstPercent === '' || form.gstPercent === null || form.gstPercent === undefined ? null : Number(form.gstPercent),
    notes_in: form.notes || null,
    line_items_in: form.lineItems.map((li) => ({ item_id: li.itemId, quantity: li.quantity, rate: li.rate })),
  });
  if (error) throw error;
  return data;
}

/**
 * Admin only, server-side. Sets/edits the client PO number and/or "our"
 * invoice number on an already-authorized dispatch — updateMaterialDispatch
 * above can't be used once a dispatch is authorized (see this file's own
 * top comment on the no-update-policy discipline), so this stays the only
 * edit path for those two billing fields after that point.
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

/**
 * Admin only, server-side. Clears a dispatch's payment status back to
 * Pending — the counterpart to markDispatchPaymentReceived above, for
 * correcting a payment marked by mistake.
 * @param {string} dispatchId
 * @param {any} [client]
 */
export async function revertDispatchPayment(dispatchId, client = supabase) {
  if (!client) throw new Error('Supabase is not configured.');
  const { data, error } = await client.rpc('revert_dispatch_payment', { target_dispatch_id: dispatchId });
  if (error) throw error;
  return data;
}
