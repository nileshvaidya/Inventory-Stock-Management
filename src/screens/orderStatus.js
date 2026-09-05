// Order Status (Phase 2): every PO, filterable by date range/Project/
// Status, with CSV export. Screen itself is Admin/Purchase; the
// soft-delete ("Delete") action is admin-only (per user request),
// enforced both here (button hidden for non-admin) and at the RLS layer
// (purchase_orders' update policy — see supabase/schema.sql).
import { getCurrentProfile } from '../auth.js';
import { renderShell } from '../layout.js';
import { escapeHtml } from '../components.js';
import { createStore } from '../state.js';
import { canViewModule } from '../navPermissions.js';
import { fetchPurchaseOrders, softDeletePurchaseOrder } from '../purchaseOrders.js';
import { fetchProjects } from '../projects.js';
import { PO_STATUSES, poStatusLabel, poStatusTagClass } from '../poStatus.js';
import { toCsv, downloadCsv } from '../csvExport.js';
import { repaintPreservingFocus, afterFocusSettles } from '../domFocus.js';

export async function render(container) {
  const user = await getCurrentProfile();
  if (!user) {
    window.location.hash = '#/login';
    return;
  }
  if (!canViewModule('/order-status', user.role)) {
    window.location.hash = '#/dashboard';
    return;
  }
  const canEdit = user.role === 'admin';

  const content = renderShell(container, { activeRoute: '/order-status', user });
  content.setAttribute('data-screen', 'order-status');
  const store = createStore({
    orders: [],
    projects: [],
    loading: true,
    error: false,
    dateFrom: '',
    dateTo: '',
    projectId: '',
    status: '',
    includeArchived: false,
  });

  async function load() {
    store.setState({ loading: true, error: false });
    const s = store.getState();
    try {
      const orders = await fetchPurchaseOrders({
        dateFrom: s.dateFrom || undefined,
        dateTo: s.dateTo || undefined,
        projectId: s.projectId || undefined,
        status: s.status || undefined,
        includeArchived: s.includeArchived,
      });
      store.setState({ orders, loading: false, error: false });
    } catch {
      store.setState({ loading: false, error: true });
    }
  }

  function paint() {
    // Without repaintPreservingFocus, any repaint (a filter's 'change',
    // the date fields' deferred 'blur' above) drops focus to <body> — this
    // screen never got the fix the other screens received when the
    // original per-keystroke focus-loss bug was found, since none of its
    // fields need live per-keystroke reactivity. It still needs the same
    // wrapper for anything that re-renders while a field has focus.
    repaintPreservingFocus(content, () => {
      renderContent(content, store.getState(), canEdit);
      wireEvents(content, store, load);
    });
  }

  store.subscribe(paint);
  paint();
  const projects = await fetchProjects();
  store.setState({ projects });
  await load();
}

function renderContent(container, state, canEdit) {
  container.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;flex-wrap:wrap;gap:12px">
      <h1 style="margin:0">Order Status</h1>
      <button type="button" class="btn btn-secondary" data-action="export-csv">Export CSV</button>
    </div>

    <div class="card elev-sm" style="margin-bottom:16px">
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;align-items:end">
        <div class="field"><label for="filter-date-from">From</label>
          <input class="input" id="filter-date-from" type="date" data-action="filter-date-from" value="${escapeHtml(state.dateFrom)}" />
        </div>
        <div class="field"><label for="filter-date-to">To</label>
          <input class="input" id="filter-date-to" type="date" data-action="filter-date-to" value="${escapeHtml(state.dateTo)}" />
        </div>
        <div class="field"><label for="filter-project">Project</label>
          <select class="input" id="filter-project" data-action="filter-project">
            <option value="">All</option>
            ${state.projects.map((p) => `<option value="${escapeHtml(p.id)}" ${state.projectId === p.id ? 'selected' : ''}>${escapeHtml(p.name)}</option>`).join('')}
          </select>
        </div>
        <div class="field"><label for="filter-status">Status</label>
          <select class="input" id="filter-status" data-action="filter-status">
            <option value="">All</option>
            ${PO_STATUSES.map((s) => `<option value="${escapeHtml(s)}" ${state.status === s ? 'selected' : ''}>${escapeHtml(poStatusLabel(s))}</option>`).join('')}
          </select>
        </div>
        <label style="display:flex;align-items:center;gap:6px;font-size:13px;padding-bottom:8px">
          <input type="checkbox" data-action="filter-archived" ${state.includeArchived ? 'checked' : ''} /> Show archived
        </label>
      </div>
    </div>

    <div class="card elev-sm" style="padding:0;overflow-x:auto">
      ${
        state.loading
          ? `<div style="padding:20px;font-size:13px;color:var(--color-neutral-500)">Loading…</div>`
          : state.error
            ? `<div style="padding:20px;text-align:center">
                <p style="font-size:13px;color:var(--color-accent-2-200);margin:0 0 10px">Couldn't load purchase orders.</p>
                <button type="button" class="btn btn-secondary" data-action="retry">Retry</button>
              </div>`
            : state.orders.length === 0
              ? `<div style="padding:20px;font-size:13px;color:var(--color-neutral-500)">No purchase orders match these filters.</div>`
              : `<table class="table" style="min-width:680px">
                  <thead><tr><th>PO Number</th><th>Project</th><th>Vendor</th><th>Order Date</th><th>Status</th><th>Actions</th></tr></thead>
                  <tbody>${state.orders.map((po) => renderRow(po, canEdit)).join('')}</tbody>
                </table>`
      }
    </div>
  `;
}

function renderRow(po, canEdit) {
  const archived = Boolean(po.deleted_at);
  return `
    <tr data-po-row="${escapeHtml(po.id)}" style="${archived ? 'opacity:0.55' : ''}">
      <td>${escapeHtml(po.po_number || '—')}</td>
      <td>${escapeHtml(po.project?.name || '—')}</td>
      <td>${escapeHtml(po.vendor?.name || '—')}</td>
      <td>${escapeHtml(po.order_date)}</td>
      <td><span class="tag ${poStatusTagClass(po.status)}">${escapeHtml(poStatusLabel(po.status))}${archived ? ' (archived)' : ''}</span></td>
      <td>
        ${
          archived || !canEdit
            ? ''
            : `<button type="button" class="btn btn-ghost" data-action="delete-po" data-id="${escapeHtml(po.id)}" style="padding:4px 10px;font-size:12px">Delete</button>`
        }
      </td>
    </tr>`;
}

function wireEvents(container, store, load) {
  const bindFilter = (selector, key, transform = (v) => v) => {
    container.querySelector(selector)?.addEventListener('change', (e) => {
      store.setState({ [key]: transform(e.target.value) });
      load();
    });
  };
  // Date fields use 'blur', not the 'change' the other filters share above:
  // Chrome fires 'change' on a date input on every completed segment, not
  // just once the full date is committed, so wiring it the same way as a
  // <select> would re-render (destroying/recreating the input, since this
  // screen doesn't use repaintPreservingFocus — there's no other live-typed
  // field to preserve) on every keystroke while the user is still typing a
  // date, and can also fight the browser's own Tab-driven focus transfer
  // out of the field (see domFocus.js's afterFocusSettles for why the
  // state update itself needs deferring, not just the event choice).
  const bindDateFilter = (selector, key) => {
    container.querySelector(selector)?.addEventListener('blur', (e) => {
      const value = e.target.value;
      afterFocusSettles(() => {
        store.setState({ [key]: value });
        load();
      });
    });
  };
  bindDateFilter('[data-action="filter-date-from"]', 'dateFrom');
  bindDateFilter('[data-action="filter-date-to"]', 'dateTo');
  bindFilter('[data-action="filter-project"]', 'projectId');
  bindFilter('[data-action="filter-status"]', 'status');
  container.querySelector('[data-action="filter-archived"]')?.addEventListener('change', (e) => {
    store.setState({ includeArchived: e.target.checked });
    load();
  });

  container.querySelector('[data-action="retry"]')?.addEventListener('click', load);

  container.querySelectorAll('[data-action="delete-po"]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!window.confirm('Archive this purchase order?')) return;
      await softDeletePurchaseOrder(btn.dataset.id);
      await load();
    });
  });

  container.querySelector('[data-action="export-csv"]')?.addEventListener('click', () => {
    const { orders } = store.getState();
    const csv = toCsv(
      orders.map((po) => ({
        po_number: po.po_number || '',
        project: po.project?.name || '',
        vendor: po.vendor?.name || '',
        order_date: po.order_date,
        status: poStatusLabel(po.status),
      })),
      [
        { key: 'po_number', header: 'PO Number' },
        { key: 'project', header: 'Project' },
        { key: 'vendor', header: 'Vendor' },
        { key: 'order_date', header: 'Order Date' },
        { key: 'status', header: 'Status' },
      ]
    );
    downloadCsv(csv, `order-status-${new Date().toISOString().slice(0, 10)}.csv`);
  });
}
