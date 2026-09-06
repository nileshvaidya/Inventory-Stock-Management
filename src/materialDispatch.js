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
 * Two-step insert (dispatch header, then its line items) — same
 * no-nested-insert caveat as createInward in materialInward.js. Creating
 * a dispatch never moves stock by itself; only authorizing it does.
 * @param {{ dispatchDate: string, reference?: string|null, notes?: string|null, createdBy: string,
 *   lineItems: { itemId: string, quantity: number }[] }} form
 * @param {any} [client]
 */
export async function createMaterialDispatch(form, client = supabase) {
  if (!client) throw new Error('Supabase is not configured.');

  const { data: dispatch, error: dispatchError } = await client
    .from('material_dispatch')
    .insert({
      dispatch_date: form.dispatchDate,
      reference: form.reference || null,
      notes: form.notes || null,
      created_by: form.createdBy,
    })
    .select()
    .single();
  if (dispatchError) throw dispatchError;

  const rows = form.lineItems
    .filter((li) => Number(li.quantity) > 0)
    .map((li) => ({ dispatch_id: dispatch.id, item_id: li.itemId, quantity: Number(li.quantity) }));

  if (rows.length > 0) {
    const { error: itemsError } = await client.from('material_dispatch_line_items').insert(rows);
    if (itemsError) throw itemsError;
  }

  return dispatch;
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
 * payment for this dispatch has come in.
 * @param {string} dispatchId
 * @param {any} [client]
 */
export async function markDispatchPaymentReceived(dispatchId, client = supabase) {
  if (!client) throw new Error('Supabase is not configured.');
  const { data, error } = await client.rpc('mark_dispatch_payment_received', { target_dispatch_id: dispatchId });
  if (error) throw error;
  return data;
}
