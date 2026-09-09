// Roles & Rights (direct request) data layer — the client-side half of
// supabase/schema.sql's role_permissions table. PERMISSIONS is the
// human-readable metadata for the same 7 capability keys that table's
// check constraint enforces; keep the two in sync by hand, same
// convention as src/roles.js/users_role_check. 'admin' is deliberately
// absent from both — it always has every permission, unconditionally,
// and can't be edited (see admin_set_role_permission in schema.sql).
import { supabase } from './api.js';

export const PERMISSIONS = [
  {
    key: 'manage_purchasing',
    label: 'Purchasing',
    description: 'Create/edit vendors, projects, and purchase orders (PO Upload, Order Status).',
  },
  {
    key: 'manage_store_operations',
    label: 'Store Operations',
    description: 'Log material inward receipts, manual stock movements, delivery challans, and material dispatch.',
  },
  {
    key: 'manage_inspections',
    label: 'Inspections',
    description: 'Record and edit inspection results (accept/reject quantities).',
  },
  {
    key: 'manage_items',
    label: 'Item Master',
    description: 'Create/edit items and set unit rates (Inventory, Price History).',
  },
  {
    key: 'manage_finance',
    label: 'Finance',
    description: 'Create/edit invoices and upload bill documents (Invoices, Bill Payments).',
  },
  {
    key: 'manage_boms',
    label: 'BoM Builder',
    description: 'Create/edit recipes and record production.',
  },
  {
    key: 'manage_work_orders',
    label: 'Work Orders',
    description: 'Create, reserve, complete, and cancel work orders.',
  },
];

/** @param {any} [client] */
export async function fetchRolePermissions(client = supabase) {
  if (!client) return [];
  const { data, error } = await client.from('role_permissions').select('*');
  if (error) throw error;
  return data;
}

/**
 * @param {{ role: string, permission: string, granted: boolean }} form
 * @param {any} [client]
 */
export async function setRolePermission(form, client = supabase) {
  if (!client) throw new Error('Supabase is not configured.');
  const { error } = await client.rpc('admin_set_role_permission', {
    target_role: form.role,
    target_permission: form.permission,
    granted: form.granted,
  });
  if (error) throw error;
}

/**
 * Whether `role` can exercise `permission` — 'admin' always can, every
 * other role only if a matching row exists in the rows fetched by
 * fetchRolePermissions. Mirrors exactly what each of the 7 rewritten SQL
 * gate functions (is_purchase_or_admin, can_manage_items, etc.) checks
 * server-side, so client-side button visibility matches what the server
 * will actually allow.
 * @param {Array<{ role: string, permission: string }>} rows
 * @param {string|null|undefined} role
 * @param {string} permission
 */
export function hasPermission(rows, role, permission) {
  if (role === 'admin') return true;
  return rows.some((r) => r.role === role && r.permission === permission);
}
