// Hash-based router for the single-shell app. Screens are lazy-loaded ES
// modules, each exporting render(container). Every module in the sidebar
// gets a route from Phase 0 on, even though most are placeholder screens
// until their phase lands (see README.md's phase list).
import { getSessionUser } from './auth.js';

export const routes = {
  '/login': () => import('./screens/login.js'),
  '/dashboard': () => import('./screens/dashboard.js'),
  '/po-upload': () => import('./screens/poUpload.js'),
  '/order-status': () => import('./screens/orderStatus.js'),
  '/material-inward': () => import('./screens/materialInward.js'),
  '/inspection': () => import('./screens/inspection.js'),
  '/master-material-status': () => import('./screens/masterMaterialStatus.js'),
  '/inventory': () => import('./screens/inventory.js'),
  '/bom-builder': () => import('./screens/bomBuilder.js'),
  '/work-orders': () => import('./screens/workOrders.js'),
  '/invoices': () => import('./screens/invoices.js'),
  '/reports': () => import('./screens/reports.js'),
  '/users': () => import('./screens/users.js'),
  '/action-log': () => import('./screens/actionLog.js'),
  '/bill-payments': () => import('./screens/billPayments.js'),
  '/help': () => import('./screens/help.js'),
};

export const PROTECTED_ROUTES = new Set(Object.keys(routes).filter((r) => r !== '/login'));
export const DEFAULT_ROUTE = '/login';

export function normalizePath(hash) {
  const path = String(hash || '').replace(/^#/, '');
  return path in routes ? path : DEFAULT_ROUTE;
}

/**
 * @param {HTMLElement} container
 * @param {string} [hash]
 * @param {() => Promise<unknown>} [sessionCheck] injectable for tests
 */
export async function renderRoute(container, hash = window.location.hash, sessionCheck = getSessionUser) {
  let path = normalizePath(hash);

  if (PROTECTED_ROUTES.has(path)) {
    const user = await sessionCheck();
    if (!user) path = DEFAULT_ROUTE;
  }

  const mod = await routes[path]();
  container.innerHTML = '';
  await mod.render(container);
  return path;
}

// A tab left open across a new deploy still holds the old JS bundle, whose
// dynamic import() calls point at chunk filenames (content-hashed) that no
// longer exist on the server once the new build has replaced them. That
// import rejects, and with no handler the failure was silent: the clicked
// link's hash still updates the URL bar, but renderRoute never gets far
// enough to swap the screen — from the user's side, the link just does
// nothing. Recover by reloading once to pick up the fresh index.html and
// chunk manifest; a second failure after that is a real error, not a stale
// bundle, so it's left to surface instead of reloading forever.
const RELOAD_ONCE_KEY = 'ism-router-reload-once';

export function startRouter(container) {
  const handler = () =>
    renderRoute(container)
      .then(() => sessionStorage.removeItem(RELOAD_ONCE_KEY))
      .catch((err) => {
        console.error('Route render failed', err);
        if (!sessionStorage.getItem(RELOAD_ONCE_KEY)) {
          sessionStorage.setItem(RELOAD_ONCE_KEY, '1');
          window.location.reload();
        }
      });
  window.addEventListener('hashchange', handler);
  if (!window.location.hash) {
    window.location.hash = `#${DEFAULT_ROUTE}`;
  } else {
    handler();
  }
  return handler;
}
