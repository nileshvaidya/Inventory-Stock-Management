// Reports (Phase 8): three read-only reports built entirely on existing
// data — no new schema, no new RLS. Admin/Authorized/Production, per
// navPermissions.js (deliberately not Store, unlike Work Orders/
// Inventory — not this screen's call to make, just what's configured).
//
// - Stock & Reservations: every item with an active hold, expandable into
//   which work order(s) are holding it.
// - Shortages: every component still short somewhere in an open or
//   reserved work order's exploded requirements (Phase 7).
// - Below Reorder: items whose *available* (not just on-hand) quantity
//   has dropped under its reorder level — same figure Inventory (Phase 4)
//   flags, as a focused, exportable list.
import { getCurrentProfile } from '../auth.js';
import { renderShell } from '../layout.js';
import { escapeHtml } from '../components.js';
import { createStore } from '../state.js';
import { canViewModule } from '../navPermissions.js';
import { fetchAvailableStock } from '../inventory.js';
import { fetchActiveReservations, fetchShortages } from '../reports.js';
import { toCsv, downloadCsv } from '../csvExport.js';

const TABS = [
  { id: 'reservations', label: 'Stock & Reservations' },
  { id: 'shortages', label: 'Shortages' },
  { id: 'below-reorder', label: 'Below Reorder' },
];

function initialState() {
  return {
    activeTab: 'reservations',
    loading: true,
    error: false,
    stock: [],
    reservations: [],
    shortages: [],
    openItemId: null,
  };
}

export async function render(container) {
  const user = await getCurrentProfile();
  if (!user) {
    window.location.hash = '#/login';
    return;
  }
  if (!canViewModule('/reports', user.role)) {
    window.location.hash = '#/dashboard';
    return;
  }

  const content = renderShell(container, { activeRoute: '/reports', user });
  content.setAttribute('data-screen', 'reports');
  const store = createStore(initialState());

  async function load() {
    store.setState({ loading: true, error: false });
    try {
      const [stock, reservations, shortages] = await Promise.all([fetchAvailableStock(), fetchActiveReservations(), fetchShortages()]);
      store.setState({ stock, reservations, shortages, loading: false, error: false });
    } catch {
      store.setState({ loading: false, error: true });
    }
  }

  function paint() {
    renderContent(content, store.getState());
    wireEvents(content, store, load);
  }

  store.subscribe(paint);
  paint();
  await load();
}

function belowReorderRows(stock) {
  return stock.filter((row) => row.reorder_level !== null && Number(row.available_qty) < Number(row.reorder_level));
}

function reservedRows(stock) {
  return stock.filter((row) => Number(row.reserved_qty) > 0);
}

function renderContent(container, state) {
  container.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;flex-wrap:wrap;gap:12px">
      <h1 style="margin:0">Reports</h1>
      ${!state.loading && !state.error ? `<button type="button" class="btn btn-secondary" data-action="export-csv">Export CSV</button>` : ''}
    </div>

    <div style="display:flex;gap:8px;margin-bottom:16px;flex-wrap:wrap">
      ${TABS.map(
        (tab) =>
          `<button type="button" class="btn ${state.activeTab === tab.id ? 'btn-primary' : 'btn-ghost'}" data-action="switch-tab" data-tab="${tab.id}" style="padding:6px 14px;font-size:13px">${escapeHtml(tab.label)}</button>`
      ).join('')}
    </div>

    <div class="card elev-sm" style="padding:0;overflow-x:auto">
      ${
        state.loading
          ? `<div style="padding:20px;font-size:13px;color:var(--color-neutral-500)">Loading…</div>`
          : state.error
            ? `<div style="padding:20px;text-align:center">
                <p style="font-size:13px;color:var(--color-accent-2-200);margin:0 0 10px">Couldn't load reports.</p>
                <button type="button" class="btn btn-secondary" data-action="retry">Retry</button>
              </div>`
            : renderTab(state)
      }
    </div>
  `;
}

function renderTab(state) {
  if (state.activeTab === 'reservations') return renderReservationsTab(state);
  if (state.activeTab === 'shortages') return renderShortagesTab(state);
  return renderBelowReorderTab(state);
}

function renderReservationsTab(state) {
  const rows = reservedRows(state.stock);
  if (rows.length === 0) {
    return `<div style="padding:20px;font-size:13px;color:var(--color-neutral-500)">No active reservations.</div>`;
  }
  return `<table class="table" style="min-width:680px">
      <thead><tr><th>Item</th><th>Current</th><th>Reserved</th><th>Available</th><th></th></tr></thead>
      <tbody>${rows.map((row) => renderReservationRow(row, state)).join('')}</tbody>
    </table>`;
}

function renderReservationRow(row, state) {
  const isOpen = state.openItemId === row.item_id;
  const rows = [
    `<tr data-reservation-row="${escapeHtml(row.item_id)}">
      <td>${escapeHtml(row.name)}</td>
      <td>${row.current_qty}</td>
      <td>${row.reserved_qty}</td>
      <td>${row.available_qty}</td>
      <td><button type="button" class="btn btn-ghost" data-action="toggle-item" data-id="${escapeHtml(row.item_id)}" style="padding:4px 10px;font-size:12px">${isOpen ? 'Hide' : 'Held By'}</button></td>
    </tr>`,
  ];
  if (isOpen) {
    const holders = state.reservations.filter((r) => r.item_id === row.item_id);
    rows.push(`
      <tr data-reservation-detail-row="${escapeHtml(row.item_id)}">
        <td colspan="5" style="padding:12px 14px;border-top:1px solid var(--color-divider)">
          ${
            holders.length === 0
              ? `<p style="font-size:13px;color:var(--color-neutral-500)">No work orders hold this item.</p>`
              : `<table class="table" style="min-width:420px">
                  <thead><tr><th>Work Order (produces)</th><th>WO Qty</th><th>Reserved Qty</th></tr></thead>
                  <tbody>
                    ${holders
                      .map(
                        (h) => `<tr><td>${escapeHtml(h.work_order?.output_item?.name || '—')}</td><td>${h.work_order?.quantity}</td><td>${h.quantity}</td></tr>`
                      )
                      .join('')}
                  </tbody>
                </table>`
          }
        </td>
      </tr>
    `);
  }
  return rows.join('');
}

function renderShortagesTab(state) {
  if (state.shortages.length === 0) {
    return `<div style="padding:20px;font-size:13px;color:var(--color-neutral-500)">No shortages against any open or reserved work order.</div>`;
  }
  return `<table class="table" style="min-width:680px">
      <thead><tr><th>Item</th><th>Needed For</th><th>WO Status</th><th>Shortfall</th></tr></thead>
      <tbody>
        ${state.shortages
          .map(
            (row) => `
          <tr data-shortage-row="${escapeHtml(row.id)}">
            <td>${escapeHtml(row.item?.name || '—')}</td>
            <td>${escapeHtml(row.work_order?.output_item?.name || '—')} (${row.work_order?.quantity})</td>
            <td>${escapeHtml(row.work_order?.status || '—')}</td>
            <td><span class="tag tag-accent-2">${row.shortfall_qty}</span></td>
          </tr>`
          )
          .join('')}
      </tbody>
    </table>`;
}

function renderBelowReorderTab(state) {
  const rows = belowReorderRows(state.stock);
  if (rows.length === 0) {
    return `<div style="padding:20px;font-size:13px;color:var(--color-neutral-500)">No items are below their reorder level.</div>`;
  }
  return `<table class="table" style="min-width:680px">
      <thead><tr><th>Item</th><th>Category</th><th>UoM</th><th>Current</th><th>Reserved</th><th>Available</th><th>Reorder Level</th></tr></thead>
      <tbody>
        ${rows
          .map(
            (row) => `
          <tr data-below-reorder-row="${escapeHtml(row.item_id)}">
            <td>${escapeHtml(row.name)}</td>
            <td>${escapeHtml(row.category || '—')}</td>
            <td>${escapeHtml(row.unit_of_measure || '—')}</td>
            <td>${row.current_qty}</td>
            <td>${row.reserved_qty}</td>
            <td>${row.available_qty}</td>
            <td>${row.reorder_level}</td>
          </tr>`
          )
          .join('')}
      </tbody>
    </table>`;
}

function exportActiveTab(state) {
  if (state.activeTab === 'reservations') {
    const rows = reservedRows(state.stock);
    const csv = toCsv(
      rows.map((r) => ({ item: r.name, current: r.current_qty, reserved: r.reserved_qty, available: r.available_qty })),
      [
        { key: 'item', header: 'Item' },
        { key: 'current', header: 'Current' },
        { key: 'reserved', header: 'Reserved' },
        { key: 'available', header: 'Available' },
      ]
    );
    downloadCsv(csv, `reports-stock-reservations-${new Date().toISOString().slice(0, 10)}.csv`);
    return;
  }
  if (state.activeTab === 'shortages') {
    const csv = toCsv(
      state.shortages.map((r) => ({
        item: r.item?.name || '',
        needed_for: r.work_order?.output_item?.name || '',
        wo_qty: r.work_order?.quantity,
        wo_status: r.work_order?.status || '',
        shortfall: r.shortfall_qty,
      })),
      [
        { key: 'item', header: 'Item' },
        { key: 'needed_for', header: 'Needed For' },
        { key: 'wo_qty', header: 'WO Qty' },
        { key: 'wo_status', header: 'WO Status' },
        { key: 'shortfall', header: 'Shortfall' },
      ]
    );
    downloadCsv(csv, `reports-shortages-${new Date().toISOString().slice(0, 10)}.csv`);
    return;
  }
  const rows = belowReorderRows(state.stock);
  const csv = toCsv(
    rows.map((r) => ({
      item: r.name,
      category: r.category || '',
      uom: r.unit_of_measure || '',
      current: r.current_qty,
      reserved: r.reserved_qty,
      available: r.available_qty,
      reorder_level: r.reorder_level,
    })),
    [
      { key: 'item', header: 'Item' },
      { key: 'category', header: 'Category' },
      { key: 'uom', header: 'UoM' },
      { key: 'current', header: 'Current' },
      { key: 'reserved', header: 'Reserved' },
      { key: 'available', header: 'Available' },
      { key: 'reorder_level', header: 'Reorder Level' },
    ]
  );
  downloadCsv(csv, `reports-below-reorder-${new Date().toISOString().slice(0, 10)}.csv`);
}

function wireEvents(container, store, load) {
  container.querySelector('[data-action="retry"]')?.addEventListener('click', load);

  container.querySelectorAll('[data-action="switch-tab"]').forEach((btn) => {
    btn.addEventListener('click', () => {
      store.setState({ activeTab: btn.dataset.tab, openItemId: null });
    });
  });

  container.querySelectorAll('[data-action="toggle-item"]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const state = store.getState();
      const itemId = btn.dataset.id;
      store.setState({ openItemId: state.openItemId === itemId ? null : itemId });
    });
  });

  container.querySelector('[data-action="export-csv"]')?.addEventListener('click', () => {
    exportActiveTab(store.getState());
  });
}
