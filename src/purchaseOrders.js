// Purchase Orders data layer (Phase 2). Company-wide read; create
// restricted to purchase/admin, direct update to admin only, server-side
// via RLS.
//
// Order Status addendum (direct request): double-clicking a PO on Order
// Status re-opens it on PO Upload for editing. fetchPurchaseOrderById
// loads one PO with its line items for that form; updatePurchaseOrder
// saves it via the admin-only admin_update_purchase_order() RPC (see
// supabase/schema.sql) rather than a plain table update/insert/delete —
// po_line_items has no update/delete policy of its own, only insert.
import { supabase } from './api.js';

/**
 * @param {{ dateFrom?: string, dateTo?: string, projectId?: string, status?: string, includeArchived?: boolean }} [filters]
 * @param {any} [client]
 */
export async function fetchPurchaseOrders(filters = {}, client = supabase) {
  if (!client) return [];
  let query = client
    .from('purchase_orders')
    .select('*, project:projects(id, name), vendor:vendors(id, name)')
    .order('order_date', { ascending: false });

  if (!filters.includeArchived) query = query.is('deleted_at', null);
  if (filters.dateFrom) query = query.gte('order_date', filters.dateFrom);
  if (filters.dateTo) query = query.lte('order_date', filters.dateTo);
  if (filters.projectId) query = query.eq('project_id', filters.projectId);
  if (filters.status) query = query.eq('status', filters.status);

  const { data, error } = await query;
  if (error) throw error;
  return data;
}

/**
 * Two-step insert (PO row, then its line items) — Supabase has no nested
 * insert, so a failure after the PO row is created but before line items
 * land would leave an orphaned empty PO. Acceptable for Phase 2 (no
 * multi-table transaction RPC yet); revisit if this proves to be a real
 * problem in practice.
 * @param {{ poNumber?: string|null, projectId: string, vendorId?: string|null, orderDate: string,
 *   paymentTermsDays?: number|null, statedTotal?: number|null, sourcePdfName?: string|null,
 *   createdBy: string, lineItems: { itemName: string, quantity: number, rate: number, itemId?: string|null }[] }} form
 * @param {any} [client]
 */
export async function createPurchaseOrder(form, client = supabase) {
  if (!client) throw new Error('Supabase is not configured.');

  const { data: po, error: poError } = await client
    .from('purchase_orders')
    .insert({
      po_number: form.poNumber || null,
      project_id: form.projectId,
      vendor_id: form.vendorId || null,
      order_date: form.orderDate,
      payment_terms_days: form.paymentTermsDays ?? null,
      stated_total: form.statedTotal ?? null,
      source_pdf_name: form.sourcePdfName || null,
      created_by: form.createdBy,
    })
    .select()
    .single();
  if (poError) throw poError;

  if (form.lineItems.length > 0) {
    const { error: itemsError } = await client.from('po_line_items').insert(
      form.lineItems.map((item) => ({
        po_id: po.id,
        item_name: item.itemName,
        quantity: item.quantity,
        rate: item.rate,
        item_id: item.itemId || null,
      }))
    );
    if (itemsError) throw itemsError;
  }

  return po;
}

/**
 * @param {string} poId
 * @param {any} [client]
 */
export async function softDeletePurchaseOrder(poId, client = supabase) {
  if (!client) throw new Error('Supabase is not configured.');
  const { error } = await client.from('purchase_orders').update({ deleted_at: new Date().toISOString() }).eq('id', poId);
  if (error) throw error;
}

/**
 * One PO with its line items, for PO Upload's edit mode.
 * @param {string} poId
 * @param {any} [client]
 */
export async function fetchPurchaseOrderById(poId, client = supabase) {
  if (!client) return null;
  const { data, error } = await client
    .from('purchase_orders')
    .select('*, project:projects(id, name), vendor:vendors(id, name), line_items:po_line_items(*)')
    .eq('id', poId)
    .single();
  if (error) throw error;
  return data;
}

/**
 * Admin only, server-side (see this file's own top comment). Line items
 * carrying an id are updated in place, ones without an id are new inserts,
 * and any existing line item missing from the list is deleted — see
 * admin_update_purchase_order() in supabase/schema.sql for why this isn't
 * a blind delete-and-reinsert.
 * @param {string} poId
 * @param {{ poNumber?: string|null, projectId: string, vendorId?: string|null, orderDate: string,
 *   paymentTermsDays?: number|null, statedTotal?: number|null,
 *   lineItems: { id?: string|null, itemName: string, quantity: number, rate: number, itemId?: string|null }[] }} form
 * @param {any} [client]
 */
export async function updatePurchaseOrder(poId, form, client = supabase) {
  if (!client) throw new Error('Supabase is not configured.');
  const { error } = await client.rpc('admin_update_purchase_order', {
    target_po_id: poId,
    po_number_in: form.poNumber || null,
    project_id_in: form.projectId,
    vendor_id_in: form.vendorId || null,
    order_date_in: form.orderDate,
    payment_terms_days_in: form.paymentTermsDays ?? null,
    stated_total_in: form.statedTotal ?? null,
    line_items_in: form.lineItems.map((li) => ({
      id: li.id || null,
      item_name: li.itemName,
      quantity: li.quantity,
      rate: li.rate,
      item_id: li.itemId || null,
    })),
  });
  if (error) throw error;
}
