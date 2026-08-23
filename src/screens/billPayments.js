// Restricted module (build brief §1): "must not appear in menus, routes,
// API responses, or the in-app help file for non-authorized users."
// layout.js already keeps this out of the nav for anyone but the
// 'authorized' role; this route-level guard is the second layer — direct
// navigation to #/bill-payments by a non-authorized (or role-less) user
// redirects away instead of showing even the placeholder content. Phase 10
// adds the third layer (RLS on the bill_payments table itself).
import { getCurrentProfile } from '../auth.js';
import { makePlaceholderScreen } from '../placeholderScreen.js';

const renderPlaceholder = makePlaceholderScreen({
  route: '/bill-payments',
  title: 'Bill Payments',
  phase: 10,
  description: 'Upload/scan bills, link to a PO/Invoice, and mark received on payment. Authorized role only.',
});

export async function render(container) {
  const user = await getCurrentProfile();
  if (!user) {
    window.location.hash = '#/login';
    return;
  }
  if (user.role !== 'authorized') {
    window.location.hash = '#/dashboard';
    return;
  }
  await renderPlaceholder(container);
}
