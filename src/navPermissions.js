// Which roles see which sidebar module (P1-2). Neither the build brief nor
// the (still pending) Claude Design mockup specifies this matrix — it's an
// assumption made to unblock Phase 1, grouped by what each module is
// actually for. Flag any correction and this is a one-file change.
//
// `null` (no role assigned yet) sees only Dashboard + Help — least
// privilege until an admin assigns a real role, not "everything because
// nothing else has real content yet" (that was fine for Phase 0 alone,
// less so once Users & Roles is real).
export const MODULE_ROLES = {
  '/dashboard': null, // every signed-in user, role or not
  '/po-upload': ['admin', 'purchase'],
  '/order-status': ['admin', 'purchase'],
  '/material-inward': ['admin', 'store'],
  '/inspection': ['admin', 'inspector'],
  '/master-material-status': ['admin', 'purchase', 'store', 'inspector'],
  '/inventory': ['admin', 'store', 'production'],
  '/bom-builder': ['admin', 'production'],
  '/work-orders': ['admin', 'production', 'store'],
  '/invoices': ['admin', 'authorized'],
  '/reports': ['admin', 'authorized', 'production'],
  '/users': ['admin'],
  '/action-log': ['admin'],
  '/bill-payments': ['authorized'],
  '/help': null, // every signed-in user
};

/**
 * @param {string} route
 * @param {string|null|undefined} role
 */
export function canViewModule(route, role) {
  const allowed = MODULE_ROLES[route];
  if (allowed === null || allowed === undefined) return true;
  return allowed.includes(role);
}
