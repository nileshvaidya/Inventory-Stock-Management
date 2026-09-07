// Dashboard (Phase 0 landing page, filled in after the fact): real KPI
// cards + a recent-activity feed, reusing each module's own data layer —
// no new schema, no new RLS. Direct user report: the Dashboard was still
// showing the Phase 0 placeholder text with no real content.
//
// Every card is gated by the same canViewModule() check the sidebar uses,
// so a role never even issues a query against a table its RLS policy
// would reject (e.g. a purchase-only user never calls fetchInvoices) —
// and each card's own fetch is caught independently, so one failing
// widget shows "—" instead of taking down the whole page.
import { getCurrentProfile } from '../auth.js';
import { renderShell } from '../layout.js';
import { escapeHtml } from '../components.js';
import { createStore } from '../state.js';
import { canViewModule } from '../navPermissions.js';
import { fetchAvailableStock } from '../inventory.js';
import { fetchShortages } from '../reports.js';
import { fetchPurchaseOrders } from '../purchaseOrders.js';
import { fetchPendingInspection } from '../inspection.js';
import { fetchWorkOrders } from '../workOrders.js';
import { fetchInvoices } from '../invoices.js';
import { fetchMaterialDispatches } from '../materialDispatch.js';
import { fetchActionLog, describeAction } from '../actionLog.js';

const OPEN_PO_STATUSES = ['to_be_received', 'partially_received'];
const ACTIVE_WO_STATUSES = ['open', 'reserved'];
const RECENT_ACTIVITY_LIMIT = 8;

function belowReorderCount(stock) {
  return stock.filter((row) => row.reorder_level !== null && Number(row.available_qty) < Number(row.reorder_level)).length;
}

/**
 * Which KPI cards this role gets, and how each fetches its own count —
 * same permission check as the sidebar (navPermissions.js), so a widget
 * only ever queries a table this role can actually read.
 * @param {string|null|undefined} role
 */
function buildWidgets(role) {
  const widgets = [];
  if (canViewModule('/inventory', role)) {
    widgets.push({ key: 'below-reorder', label: 'Items Below Reorder Level', href: '#/inventory', fetch: async () => belowReorderCount(await fetchAvailableStock()) });
  }
  if (canViewModule('/order-status', role)) {
    widgets.push({
      key: 'open-pos',
      label: 'Open Purchase Orders',
      href: '#/order-status',
      fetch: async () => (await fetchPurchaseOrders()).filter((po) => OPEN_PO_STATUSES.includes(po.status)).length,
    });
  }
  if (canViewModule('/inspection', role)) {
    widgets.push({ key: 'pending-inspection', label: 'Pending Inspections', href: '#/inspection', fetch: async () => (await fetchPendingInspection()).length });
  }
  if (canViewModule('/work-orders', role)) {
    widgets.push({
      key: 'active-work-orders',
      label: 'Active Work Orders',
      href: '#/work-orders',
      fetch: async () => (await fetchWorkOrders()).filter((wo) => ACTIVE_WO_STATUSES.includes(wo.status)).length,
    });
    widgets.push({ key: 'shortages', label: 'Component Shortages', href: '#/work-orders', fetch: async () => (await fetchShortages()).length });
  }
  if (canViewModule('/invoices', role)) {
    widgets.push({ key: 'overdue-invoices', label: 'Overdue Invoices', href: '#/invoices', fetch: async () => (await fetchInvoices({ status: 'overdue' })).length });
  }
  if (canViewModule('/material-dispatch', role)) {
    widgets.push({
      key: 'pending-dispatch',
      label: 'Dispatches Awaiting Authorization',
      href: '#/material-dispatch',
      fetch: async () => (await fetchMaterialDispatches()).filter((d) => !d.authorized_at).length,
    });
  }
  return widgets;
}

function initialState() {
  return { loading: true, error: false, widgets: {}, activity: [] };
}

export async function render(container) {
  const user = await getCurrentProfile();
  if (!user) {
    window.location.hash = '#/login';
    return;
  }

  const content = renderShell(container, { activeRoute: '/dashboard', user });
  content.setAttribute('data-screen', 'dashboard');

  const widgetDefs = buildWidgets(user.role);
  const canSeeActivity = canViewModule('/action-log', user.role);
  const store = createStore(initialState());

  async function load() {
    store.setState({ loading: true, error: false });
    try {
      const [counts, activity] = await Promise.all([
        Promise.all(widgetDefs.map((w) => w.fetch().catch(() => null))),
        canSeeActivity ? fetchActionLog().catch(() => []) : Promise.resolve([]),
      ]);
      const widgets = {};
      widgetDefs.forEach((w, i) => {
        widgets[w.key] = counts[i];
      });
      store.setState({ widgets, activity: (activity ?? []).slice(0, RECENT_ACTIVITY_LIMIT), loading: false, error: false });
    } catch {
      store.setState({ loading: false, error: true });
    }
  }

  function paint() {
    renderContent(content, store.getState(), user, widgetDefs, canSeeActivity);
    wireEvents(content, store, load);
  }

  store.subscribe(paint);
  paint();
  await load();
}

function renderWidgetCard(widget, count) {
  const value = count === null || count === undefined ? '—' : count;
  return `
    <a href="${widget.href}" class="card elev-sm" data-dashboard-widget="${widget.key}" style="padding:16px;text-decoration:none;color:inherit;display:block">
      <div style="font-size:28px;font-weight:700;line-height:1.1">${value}</div>
      <div style="font-size:13px;color:var(--color-neutral-400);margin-top:4px">${escapeHtml(widget.label)}</div>
    </a>
  `;
}

function renderActivity(activity) {
  if (activity.length === 0) {
    return `<p style="font-size:13px;color:var(--color-neutral-500);margin:0">No recent activity yet.</p>`;
  }
  return `
    <div style="display:flex;flex-direction:column;gap:2px" data-role="dashboard-activity">
      ${activity
        .map(
          (row) => `
        <div style="display:flex;justify-content:space-between;gap:12px;padding:8px 0;border-bottom:1px solid var(--color-divider);font-size:13px">
          <span>${escapeHtml(describeAction(row))}${row.user?.name ? ` <span style="color:var(--color-neutral-500)">by ${escapeHtml(row.user.name)}</span>` : ''}</span>
          <span style="color:var(--color-neutral-500);white-space:nowrap">${escapeHtml(new Date(row.created_at).toLocaleString())}</span>
        </div>
      `
        )
        .join('')}
    </div>
  `;
}

function renderContent(container, state, user, widgetDefs, canSeeActivity) {
  const hasNothing = widgetDefs.length === 0 && !canSeeActivity;

  container.innerHTML = `
    <h1 style="margin-bottom:4px">Welcome, ${escapeHtml(user.name)}</h1>
    <p class="text-muted" style="margin-bottom:24px">
      ${user.role ? `Role: ${escapeHtml(user.role)}` : 'No role assigned yet — an Admin will assign one shortly.'}
    </p>

    ${
      state.error
        ? `<div class="card elev-sm" style="max-width:480px;padding:20px;text-align:center">
             <p style="font-size:13px;color:var(--color-accent-2-200);margin:0 0 10px">Couldn't load your dashboard.</p>
             <button type="button" class="btn btn-secondary" data-action="retry">Retry</button>
           </div>`
        : state.loading
          ? `<div style="padding:20px;font-size:13px;color:var(--color-neutral-500)">Loading dashboard…</div>`
          : hasNothing
            ? `<div class="card elev-sm" style="max-width:640px;padding:20px">
                 <p style="font-size:14px;color:var(--color-neutral-400);margin:0">Your role doesn't have any modules with quick stats yet — check the sidebar for what you can access, or visit <a href="#/help" style="color:var(--color-accent)">Help</a> to learn more.</p>
               </div>`
            : `
              ${
                widgetDefs.length > 0
                  ? `<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:12px;margin-bottom:24px" data-role="dashboard-widgets">
                      ${widgetDefs.map((w) => renderWidgetCard(w, state.widgets[w.key])).join('')}
                    </div>`
                  : ''
              }
              ${
                canSeeActivity
                  ? `<div class="card elev-sm" style="padding:20px">
                      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">
                        <h2 class="card-title" style="font-size:16px;margin:0">Recent Activity</h2>
                        <a href="#/action-log" style="font-size:13px;color:var(--color-accent)">View all</a>
                      </div>
                      ${renderActivity(state.activity)}
                    </div>`
                  : ''
              }
            `
    }
  `;
}

function wireEvents(container, store, load) {
  container.querySelector('[data-action="retry"]')?.addEventListener('click', load);
}
