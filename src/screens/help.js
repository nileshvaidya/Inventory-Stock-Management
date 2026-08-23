// In-app help. Build brief §3: "explicitly exclude any mention of the Bill
// Payments module from the help content shown to non-authorized roles —
// maintain two help views, or role-conditional help sections." Phase 0
// bakes in the role-conditional pattern now (renderHelp takes a role and
// only includes the restricted section when it's 'authorized') so later
// phases just add content to the right section instead of retrofitting the
// exclusion mechanism — see P10-7/P10-8 test cases in README.md.
import { getCurrentProfile } from '../auth.js';
import { renderShell } from '../layout.js';
import { escapeHtml } from '../components.js';

const SECTIONS = [
  { title: 'Dashboard', body: 'Your landing page after signing in.' },
  { title: 'PO Upload', body: 'Upload an approved PO PDF; items, quantity, and rate are parsed for review. (Phase 2)' },
  { title: 'Order Status', body: 'Track every PO by date, project/order, and status. (Phase 2)' },
  { title: 'Material Inward', body: 'Log receipts against a PO, including partial deliveries. (Phase 3)' },
  { title: 'Inspection', body: 'Accept or reject received material, in full or in part. (Phase 3)' },
  { title: 'Master Material Status', body: 'Company-wide view of every PO/item’s receipt and inspection status. (Phase 3)' },
  { title: 'Inventory', body: 'Current stock by item, with below-reorder flags and a movement ledger. (Phase 4)' },
  { title: 'BoM Builder', body: 'Build nested bills of materials and record production. (Phase 6)' },
  { title: 'Work Orders', body: 'Reserve component stock against a work order. (Phase 7)' },
  { title: 'Invoices', body: 'Link invoices to POs and track payment status and due dates. (Phase 5)' },
  { title: 'Reports', body: 'Available/reserved stock, shortfalls, and below-reorder reporting. (Phase 8)' },
  { title: 'Users & Roles', body: 'Admins manage user accounts and role assignments. (Phase 1)' },
  { title: 'Action Log', body: 'A filterable audit trail of every action across the app. (Phase 9)' },
];

// Never merged into SECTIONS above — this only ever renders when the
// viewer's role is 'authorized', enforced below.
const RESTRICTED_SECTION = {
  title: 'Bill Payments',
  body: 'Upload/scan bills and mark them received once paid. Visible only to the Authorized role. (Phase 10)',
};

/**
 * @param {string|null} role
 */
export function renderHelp(role) {
  const sections = role === 'authorized' ? [...SECTIONS, RESTRICTED_SECTION] : SECTIONS;
  return `
    <h1 style="margin-bottom:16px">Help</h1>
    ${sections
      .map(
        (s) => `
      <div class="card elev-sm" style="margin-bottom:12px">
        <h3 class="card-title" style="font-size:15px">${escapeHtml(s.title)}</h3>
        <p class="card-body">${escapeHtml(s.body)}</p>
      </div>`
      )
      .join('')}
  `;
}

export async function render(container) {
  const user = await getCurrentProfile();
  if (!user) {
    window.location.hash = '#/login';
    return;
  }

  const content = renderShell(container, { activeRoute: '/help', user });
  content.setAttribute('data-screen', 'help');
  content.innerHTML = renderHelp(user.role);
}
