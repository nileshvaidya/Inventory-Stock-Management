// Shared authenticated-app shell: desktop sidebar / mobile top bar + bottom
// tabs, real CSS breakpoints (no JS device-state switch). Ported from the
// WorkSync/Task Management scaffold's src/layout.js.
//
// NAV_ITEMS / icons are a placeholder pending the real Claude Design
// mockup export (see design-reference/README.md) — labels come from the
// build brief's module list, not yet pixel-matched to the mockup.
import { escapeHtml, renderIdentityBlock, initials } from './components.js';
import { signOutUser } from './auth.js';

const NAV_ITEMS = [
  { route: '/dashboard', label: 'Dashboard', phase: 0 },
  { route: '/po-upload', label: 'PO Upload', phase: 2 },
  { route: '/order-status', label: 'Order Status', phase: 2 },
  { route: '/material-inward', label: 'Material Inward', phase: 3 },
  { route: '/inspection', label: 'Inspection', phase: 3 },
  { route: '/master-material-status', label: 'Master Material Status', phase: 3 },
  { route: '/inventory', label: 'Inventory', phase: 4 },
  { route: '/bom-builder', label: 'BoM Builder', phase: 6 },
  { route: '/work-orders', label: 'Work Orders', phase: 7 },
  { route: '/invoices', label: 'Invoices', phase: 5 },
  { route: '/reports', label: 'Reports', phase: 8 },
  { route: '/users', label: 'Users & Roles', phase: 1 },
  { route: '/action-log', label: 'Action Log', phase: 9 },
  // Restricted module (build brief §1): must not appear in the sidebar for
  // any role other than 'authorized' — never just CSS-hidden, filtered out
  // of the nav list entirely before it's ever rendered.
  { route: '/bill-payments', label: 'Bill Payments', phase: 10, restricted: true },
];

const LOGO_SVG = (size) => `
  <svg width="${size}" height="${size}" viewBox="0 0 256 256" fill="none">
    <rect x="28" y="28" width="200" height="200" rx="28" fill="none" stroke="var(--color-accent)" stroke-width="16"/>
    <path d="M76 128 L112 164 L180 92" stroke="var(--color-accent)" stroke-width="16" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
  </svg>`;

/**
 * @param {HTMLElement} container
 * @param {{ activeRoute: string, user: { id: string, name: string, email: string, role: string|null } }} opts
 * @returns {HTMLElement} the content mount point for the calling screen to render into
 */
export function renderShell(container, { activeRoute, user }) {
  const visibleNavItems = NAV_ITEMS.filter((item) => !item.restricted || user.role === 'authorized');

  const navHtml = (mobile) =>
    visibleNavItems.map((item) => {
      const active = item.route === activeRoute;
      const cls = mobile
        ? `flex-1 text-center text-[10px] ${active ? 'text-accent' : 'text-neutral-500'}`
        : `ismnav-item ${active ? 'ismnav-item-active' : ''}`;
      return `
        <a href="#${item.route}" class="${cls}" data-nav="${item.route}">
          <span>${escapeHtml(item.label)}</span>
        </a>`;
    }).join('');

  container.innerHTML = `
    <style>
      .ismnav-item{display:flex;align-items:center;gap:10px;padding:9px 12px;border-radius:var(--radius-sm);font-size:13px;color:var(--color-neutral-300);border-left:2px solid transparent;text-decoration:none}
      .ismnav-item:hover{background:color-mix(in srgb, var(--color-text) 6%, transparent)}
      .ismnav-item-active{background:var(--color-accent-800);color:var(--color-accent-100);border-left-color:var(--color-accent)}
    </style>
    <div class="min-h-screen md:flex">
      <aside class="hidden md:flex md:flex-col w-64 flex-none p-4 overflow-y-auto" style="background:var(--color-surface);border-right:1px solid var(--color-divider)">
        <div class="flex items-center gap-2 px-1.5 pb-1">
          ${LOGO_SVG(20)}
          <span style="font-family:var(--font-heading);font-weight:600;font-size:16px">Inventory &amp; Stock</span>
        </div>
        <div class="px-1.5 pb-4" style="font-size:11px;color:var(--color-neutral-500)">ASK Info-Solutions LLP</div>
        <nav class="flex flex-col gap-1">${navHtml(false)}</nav>
        <div class="flex-1"></div>
        <a href="#/help" class="btn btn-ghost mb-2" data-nav="/help" style="text-decoration:none;text-align:center">Help</a>
        <div data-role="sidebar-identity" class="p-2 mt-3" style="border-top:1px solid var(--color-divider)"></div>
        <button type="button" class="btn btn-ghost mt-2" data-action="sign-out">Sign out</button>
      </aside>

      <div class="flex md:hidden items-center justify-between px-4 py-3" style="border-bottom:1px solid var(--color-divider)">
        <div class="flex items-center gap-2">
          ${LOGO_SVG(18)}
          <span style="font-family:var(--font-heading);font-weight:600;font-size:15px">Inventory &amp; Stock</span>
        </div>
        <div class="flex items-center gap-2">
          <a href="#/help" class="ismicon-btn" data-nav="/help" aria-label="Help" title="Help" style="width:30px;height:30px;border-radius:var(--radius-sm);border:1px solid var(--color-divider);background:transparent;color:var(--color-neutral-400);text-decoration:none;display:flex;align-items:center;justify-content:center">?</a>
          <button type="button" class="ismicon-btn" data-action="sign-out" aria-label="Sign out" style="width:30px;height:30px;border-radius:var(--radius-sm);border:1px solid var(--color-divider);background:transparent;color:var(--color-neutral-400)">⎋</button>
          <div style="width:28px;height:28px;border-radius:50%;background:var(--color-accent-800);color:var(--color-accent-100);display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:600">${escapeHtml(initials(user.name))}</div>
        </div>
      </div>

      <main class="flex-1 min-w-0 p-4 md:p-8 pb-24 md:pb-8" data-role="content"></main>

      <div class="md:hidden fixed bottom-0 left-0 right-0 flex overflow-x-auto py-2" style="background:var(--color-surface);border-top:1px solid var(--color-divider)">
        ${navHtml(true)}
      </div>
    </div>
  `;

  const identityMount = container.querySelector('[data-role="sidebar-identity"]');
  if (identityMount) identityMount.appendChild(renderIdentityBlock(user));

  container.querySelectorAll('[data-action="sign-out"]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      await signOutUser();
      window.location.hash = '#/login';
    });
  });

  return container.querySelector('[data-role="content"]');
}
