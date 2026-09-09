// Which roles see which sidebar module (P1-2). Neither the build brief nor
// the (still pending) Claude Design mockup specifies this matrix — it's an
// assumption made to unblock Phase 1, grouped by what each module is
// actually for. Flag any correction and this is a one-file change.
//
// `null` (no role assigned yet) sees only Dashboard + Help — least
// privilege until an admin assigns a real role, not "everything because
// nothing else has real content yet" (that was fine for Phase 0 alone,
// less so once Users & Roles is real).
//
// Roles & Rights addendum (direct request, reported as a bug: a role
// granted the Finance right still couldn't see Invoices at all): this
// list alone used to be the *entire* answer to "can this role see this
// screen." Now it's only the floor — canViewModule below also reveals a
// screen to any role holding the matching write right in
// MODULE_PERMISSIONS, so granting a right and seeing its screen are never
// out of sync. A screen with no entry in MODULE_PERMISSIONS (Dashboard,
// Help, Reports, Master Material Status, Users & Roles, Roles & Rights,
// Action Log) keeps exactly the fixed list below — there's no write right
// that corresponds to those, so nothing changes for them.
export const MODULE_ROLES = {
  '/dashboard': null, // every signed-in user, role or not
  '/po-upload': ['admin', 'purchase'],
  '/order-status': ['admin', 'purchase'],
  '/material-inward': ['admin', 'store'],
  '/inspection': ['admin', 'inspector'],
  '/master-material-status': ['admin', 'purchase', 'store', 'inspector'],
  '/inventory': ['admin', 'store', 'production'],
  // Same viewers as Inventory — a companion detail view of its own Unit
  // Rate column, not a separate module with its own audience.
  '/price-history': ['admin', 'store', 'production'],
  '/bom-builder': ['admin', 'production'],
  '/work-orders': ['admin', 'production', 'store'],
  '/invoices': ['admin', 'authorized'],
  // A finance document (bank submission), not an operational stock
  // screen — same role convention as Invoices/Bill Payments, not
  // Inventory's broader admin/store/production audience.
  '/stock-statement': ['admin', 'authorized'],
  '/reports': ['admin', 'authorized', 'production'],
  '/users': ['admin'],
  '/roles-and-rights': ['admin'],
  '/action-log': ['admin'],
  // Restricted module (build brief §1): must not appear for any role
  // other than 'authorized', not even admin — deliberately excluded from
  // MODULE_PERMISSIONS below too, so granting the Finance right elsewhere
  // never reopens this specific exception.
  '/bill-payments': ['authorized'],
  '/material-dispatch': ['admin', 'store'],
  '/help': null, // every signed-in user
};

// Route -> the one right (see rolePermissions.js's PERMISSIONS) that,
// once granted, reveals that screen too — on top of, never instead of,
// MODULE_ROLES' own fixed floor above. Only screens with a real write
// action tied to one of the 7 rights get an entry; a screen that's
// read-only or otherwise not gated by any of them (Dashboard, Help,
// Reports, Master Material Status, Users & Roles, Roles & Rights, Action
// Log) is intentionally absent — MODULE_ROLES alone still decides those.
// Bill Payments is also intentionally absent despite sharing Invoices'
// manage_finance right — see its own comment above.
export const MODULE_PERMISSIONS = {
  '/po-upload': 'manage_purchasing',
  '/order-status': 'manage_purchasing',
  '/material-inward': 'manage_store_operations',
  '/inspection': 'manage_inspections',
  '/inventory': 'manage_items',
  '/price-history': 'manage_items',
  '/bom-builder': 'manage_boms',
  '/work-orders': 'manage_work_orders',
  '/invoices': 'manage_finance',
  '/stock-statement': 'manage_finance',
  '/material-dispatch': 'manage_store_operations',
};

/**
 * @param {string} route
 * @param {string|null|undefined} role
 * @param {Array<{ role: string, permission: string }>} [rolePermissions] rows from fetchRolePermissions — omit only for a screen that never fetches them (nothing in MODULE_PERMISSIONS applies to a null/no-role viewer anyway)
 */
export function canViewModule(route, role, rolePermissions = []) {
  const allowed = MODULE_ROLES[route];
  if (allowed === null || allowed === undefined) return true;
  if (allowed.includes(role)) return true;
  const permission = MODULE_PERMISSIONS[route];
  if (!permission) return false;
  return rolePermissions.some((r) => r.role === role && r.permission === permission);
}
