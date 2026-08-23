// Restricted module (build brief §1): "must not appear in menus, routes,
// API responses, or the in-app help file for non-authorized users."
// layout.js keeps this out of the nav for anyone but the 'authorized'
// role, and makePlaceholderScreen (src/placeholderScreen.js) applies the
// same navPermissions check as a route-level guard, redirecting away a
// non-authorized user who navigates here directly. Phase 10 adds the
// third layer (RLS on the bill_payments table itself).
import { makePlaceholderScreen } from '../placeholderScreen.js';

export const render = makePlaceholderScreen({
  route: '/bill-payments',
  title: 'Bill Payments',
  phase: 10,
  description: 'Upload/scan bills, link to a PO/Invoice, and mark received on payment. Authorized role only.',
});
