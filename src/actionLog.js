// Action Log data layer (Phase 9): reads the action_log table, populated
// automatically by trg_log_action() (see supabase/schema.sql) — this
// module never writes to it. Admin-only RLS read; no insert/update/
// delete policy exists for direct clients at all.
import { supabase } from './api.js';

export const TABLE_LABELS = {
  users: 'User',
  vendors: 'Vendor',
  projects: 'Project',
  purchase_orders: 'Purchase Order',
  po_line_items: 'PO Line Item',
  import_field_mappings: 'Field Mapping',
  material_inward: 'Material Inward',
  material_inward_line_items: 'Inward Line Item',
  inspection_results: 'Inspection',
  items: 'Item',
  stock_movements: 'Stock Movement',
  invoices: 'Invoice',
  invoice_purchase_orders: 'Invoice-PO Link',
  boms: 'BoM Recipe',
  bom_components: 'BoM Component',
  bom_production_runs: 'Production Run',
  work_orders: 'Work Order',
  work_order_requirements: 'WO Requirement',
  stock_reservations: 'Stock Reservation',
  // material_dispatch/material_dispatch_line_items were missed when Phase
  // 11 added those tables — filled in now while touching this file for
  // Phase 12's own new table, rather than leaving Action Log showing the
  // raw table name for every dispatch-related entry.
  material_dispatch: 'Material Dispatch',
  material_dispatch_line_items: 'Dispatch Line Item',
  item_price_history: 'Item Price History',
};

export const OPERATION_LABELS = { INSERT: 'Created', UPDATE: 'Updated', DELETE: 'Deleted' };

/** @param {{ table_name: string, operation: string }} row */
export function describeAction(row) {
  const tableLabel = TABLE_LABELS[row.table_name] || row.table_name;
  const opLabel = OPERATION_LABELS[row.operation] || row.operation;
  return `${tableLabel} ${opLabel}`;
}

/**
 * Paginated via `.range()` (offset/limit), not a flat cap — the Action Log
 * screen loads 25 at a time and fetches more as the user scrolls, rather
 * than pulling the whole log up front. Callers that just want a handful
 * of recent entries (the Dashboard's activity feed) can rely on the
 * default limit and skip a page straight into it.
 * @param {{ userId?: string, tableName?: string, operation?: string, dateFrom?: string, dateTo?: string, limit?: number, offset?: number }} filters
 * @param {any} [client]
 */
export async function fetchActionLog(filters = {}, client = supabase) {
  if (!client) return [];
  const { limit = 25, offset = 0 } = filters;
  let query = client
    .from('action_log')
    .select('*, user:users(id, name, email)')
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (filters.userId) query = query.eq('user_id', filters.userId);
  if (filters.tableName) query = query.eq('table_name', filters.tableName);
  if (filters.operation) query = query.eq('operation', filters.operation);
  if (filters.dateFrom) query = query.gte('created_at', filters.dateFrom);
  if (filters.dateTo) {
    // created_at is a timestamptz, not a plain date — a naive `lte(dateTo)`
    // would compare against midnight at the *start* of that day and
    // exclude everything else on it. Use the exclusive start of the next
    // day instead so the whole "dateTo" day is included.
    const nextDay = new Date(`${filters.dateTo}T00:00:00Z`);
    nextDay.setUTCDate(nextDay.getUTCDate() + 1);
    query = query.lt('created_at', nextDay.toISOString());
  }

  const { data, error } = await query;
  if (error) throw error;
  return data;
}
