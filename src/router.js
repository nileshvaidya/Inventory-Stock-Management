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

export function startRouter(container) {
  const handler = () => renderRoute(container);
  window.addEventListener('hashchange', handler);
  if (!window.location.hash) {
    window.location.hash = `#${DEFAULT_ROUTE}`;
  } else {
    handler();
  }
  return handler;
}
