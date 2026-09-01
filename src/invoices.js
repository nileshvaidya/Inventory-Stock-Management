// Invoices data layer (Phase 5). Admin/Authorized only — RLS restricts
// both read and write to that pair (see supabase/schema.sql), unlike the
// company-wide-read tables from earlier phases: no other role has a
// stated need to see invoice/payment-term data.
import { supabase } from './api.js';

/**
 * status mirrors the three states the screen actually shows (invoices.js's
 * invoiceStatus()): 'pending' is "not yet paid and not overdue", distinct
 * from 'overdue' ("not yet paid and past due") — both need the same
 * paid_at-is-null query, then a client-side split on due_date, since
 * "overdue" isn't a stored column.
 * @param {{ vendorId?: string, status?: string, includeArchived?: boolean }} [filters]
 * @param {any} [client]
 */
export async function fetchInvoices(filters = {}, client = supabase) {
  if (!client) return [];
  let query = client
    .from('invoices')
    .select('*, vendor:vendors(id, name), invoice_purchase_orders(po:purchase_orders(id, po_number))')
    .order('due_date', { ascending: true, nullsFirst: false });

  if (!filters.includeArchived) query = query.is('deleted_at', null);
  if (filters.vendorId) query = query.eq('vendor_id', filters.vendorId);
  if (filters.status === 'paid') query = query.not('paid_at', 'is', null);
  if (filters.status === 'pending' || filters.status === 'overdue') query = query.is('paid_at', null);

  const { data, error } = await query;
  if (error) throw error;

  if (filters.status === 'pending' || filters.status === 'overdue') {
    const today = new Date().toISOString().slice(0, 10);
    const isOverdue = (row) => Boolean(row.due_date && row.due_date < today);
    return (data ?? []).filter((row) => (filters.status === 'overdue' ? isOverdue(row) : !isOverdue(row)));
  }
  return data;
}

/**
 * Two-step insert (invoice row, then its PO links) — same no-nested-insert
 * caveat as createPurchaseOrder in purchaseOrders.js.
 * @param {{ invoiceNumber?: string|null, vendorId: string, invoiceDate: string, paymentTermsDays?: number|null,
 *   dueDate?: string|null, amount: number, notes?: string|null, createdBy: string, poIds: string[] }} form
 * @param {any} [client]
 */
export async function createInvoice(form, client = supabase) {
  if (!client) throw new Error('Supabase is not configured.');

  const { data: invoice, error: invoiceError } = await client
    .from('invoices')
    .insert({
      invoice_number: form.invoiceNumber || null,
      vendor_id: form.vendorId,
      invoice_date: form.invoiceDate,
      payment_terms_days: form.paymentTermsDays ?? null,
      due_date: form.dueDate || null,
      amount: form.amount,
      notes: form.notes || null,
      created_by: form.createdBy,
    })
    .select()
    .single();
  if (invoiceError) throw invoiceError;

  if (form.poIds.length > 0) {
    const { error: linksError } = await client
      .from('invoice_purchase_orders')
      .insert(form.poIds.map((poId) => ({ invoice_id: invoice.id, po_id: poId })));
    if (linksError) throw linksError;
  }

  return invoice;
}

/**
 * @param {string} invoiceId
 * @param {any} [client]
 */
export async function markInvoicePaid(invoiceId, client = supabase) {
  if (!client) throw new Error('Supabase is not configured.');
  const { error } = await client.from('invoices').update({ paid_at: new Date().toISOString() }).eq('id', invoiceId);
  if (error) throw error;
}

/**
 * @param {string} invoiceId
 * @param {any} [client]
 */
export async function softDeleteInvoice(invoiceId, client = supabase) {
  if (!client) throw new Error('Supabase is not configured.');
  const { error } = await client.from('invoices').update({ deleted_at: new Date().toISOString() }).eq('id', invoiceId);
  if (error) throw error;
}

// Phase 10: the scanned bill document itself, stored in the private
// 'bill-documents' bucket (RLS: authorized/admin, same as invoices — see
// supabase/schema.sql) rather than on invoices.notes or similar, since a
// binary file needs Storage, not a text column. Path is namespaced by
// invoice id so re-uploads for different invoices can never collide.
const BILL_BUCKET = 'bill-documents';

/**
 * @param {string} invoiceId
 * @param {File} file
 * @param {any} [client]
 */
export async function uploadBillFile(invoiceId, file, client = supabase) {
  if (!client) throw new Error('Supabase is not configured.');
  const path = `${invoiceId}/${Date.now()}-${file.name}`;
  const { error: uploadError } = await client.storage.from(BILL_BUCKET).upload(path, file, { upsert: false });
  if (uploadError) throw uploadError;

  const { error: updateError } = await client
    .from('invoices')
    .update({ bill_file_path: path, bill_file_name: file.name })
    .eq('id', invoiceId);
  if (updateError) throw updateError;
}

/**
 * Signed URL, not getPublicUrl — the bucket is private (RLS-restricted),
 * so a viewer needs a time-limited signed link rather than a bare public
 * one that would bypass RLS entirely once handed out.
 * @param {string} path
 * @param {any} [client]
 */
export async function getBillFileUrl(path, client = supabase) {
  if (!client || !path) return null;
  const { data, error } = await client.storage.from(BILL_BUCKET).createSignedUrl(path, 300);
  if (error) throw error;
  return data?.signedUrl ?? null;
}

/**
 * @param {string} invoiceId
 * @param {string} path
 * @param {any} [client]
 */
export async function removeBillFile(invoiceId, path, client = supabase) {
  if (!client) throw new Error('Supabase is not configured.');
  if (path) {
    const { error: removeError } = await client.storage.from(BILL_BUCKET).remove([path]);
    if (removeError) throw removeError;
  }
  const { error: updateError } = await client
    .from('invoices')
    .update({ bill_file_path: null, bill_file_name: null })
    .eq('id', invoiceId);
  if (updateError) throw updateError;
}
