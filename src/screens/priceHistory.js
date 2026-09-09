// Price History (Phase 12): every rate ever recorded for every item,
// filterable by item and an effective-date range — direct user request,
// the read side of item_price_history (see supabase/schema.sql and
// itemPricing.js). Same viewers as Inventory (admin/store/production):
// this is a companion detail view of Inventory's own new Unit Rate
// column, not a separate module with its own audience.
import { getCurrentProfile } from '../auth.js';
import { renderShell } from '../layout.js';
import { escapeHtml } from '../components.js';
import { createStore } from '../state.js';
import { canViewModule } from '../navPermissions.js';
import { fetchPriceHistory } from '../itemPricing.js';
import { fetchItems } from '../items.js';
import { repaintPreservingFocus, afterFocusSettles, skipDateSegmentsOnTab, onRealBlur } from '../domFocus.js';
import { fetchRolePermissionsGuarded } from '../rolePermissions.js';

function initialState() {
  return {
    rows: [],
    items: [],
    loading: true,
    error: false,
    itemId: '',
    dateFrom: '',
    dateTo: '',
  };
}

export async function render(container) {
  const user = await getCurrentProfile();
  if (!user) {
    window.location.hash = '#/login';
    return;
  }
  // Fetched before the guard (Roles & Rights addendum) — a role granted
  // the matching right sees and can use this screen even though it's not
  // in navPermissions.js's own fixed list, so the guard has to consult
  // the same rows the sidebar link's own visibility does (canViewModule).
  const rolePermissions = await fetchRolePermissionsGuarded();
  if (!canViewModule('/price-history', user.role, rolePermissions)) {
    window.location.hash = '#/dashboard';
    return;
  }

  const content = await renderShell(container, { activeRoute: '/price-history', user, rolePermissions });
  content.setAttribute('data-screen', 'price-history');
  const store = createStore(initialState());

  async function load() {
    store.setState({ loading: true, error: false });
    const s = store.getState();
    try {
      const rows = await fetchPriceHistory({
        itemId: s.itemId || undefined,
        dateFrom: s.dateFrom || undefined,
        dateTo: s.dateTo || undefined,
      });
      store.setState({ rows, loading: false, error: false });
    } catch {
      store.setState({ loading: false, error: true });
    }
  }

  function paint() {
    repaintPreservingFocus(content, () => {
      renderContent(content, store.getState());
      wireEvents(content, store, load);
    });
  }

  store.subscribe(paint);
  paint();
  const items = await fetchItems();
  store.setState({ items });
  await load();
}

function renderContent(container, state) {
  container.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;flex-wrap:wrap;gap:12px">
      <h1 style="margin:0">Price History</h1>
    </div>

    <div class="card elev-sm" style="margin-bottom:16px">
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px">
        <div class="field"><label for="ph-filter-item">Item</label>
          <select class="input" id="ph-filter-item" data-action="filter-item">
            <option value="">All</option>
            ${state.items.map((it) => `<option value="${escapeHtml(it.id)}" ${state.itemId === it.id ? 'selected' : ''}>${escapeHtml(it.name)}</option>`).join('')}
          </select>
        </div>
        <div class="field"><label for="ph-filter-date-from">From</label>
          <input class="input" id="ph-filter-date-from" type="date" data-action="filter-date-from" value="${escapeHtml(state.dateFrom)}" />
        </div>
        <div class="field"><label for="ph-filter-date-to">To</label>
          <input class="input" id="ph-filter-date-to" type="date" data-action="filter-date-to" value="${escapeHtml(state.dateTo)}" />
        </div>
      </div>
    </div>

    <div class="card elev-sm" style="padding:0;overflow-x:auto">
      ${
        state.loading
          ? `<div style="padding:20px;font-size:13px;color:var(--color-neutral-500)">Loading…</div>`
          : state.error
            ? `<div style="padding:20px;text-align:center">
                <p style="font-size:13px;color:var(--color-accent-2-200);margin:0 0 10px">Couldn't load price history.</p>
                <button type="button" class="btn btn-secondary" data-action="retry">Retry</button>
              </div>`
            : state.rows.length === 0
              ? `<div style="padding:20px;font-size:13px;color:var(--color-neutral-500)">No price changes match these filters.</div>`
              : `<table class="table" style="min-width:600px">
                  <thead><tr><th>Item</th><th>Rate (₹)</th><th>Effective Date</th><th>Changed By</th><th>Recorded At</th></tr></thead>
                  <tbody>
                    ${state.rows
                      .map(
                        (row) => `
                      <tr data-price-history-row="${escapeHtml(row.id)}">
                        <td>${escapeHtml(row.item?.name || '—')}</td>
                        <td>${Number(row.rate).toFixed(2)}</td>
                        <td>${escapeHtml(new Date(row.effective_date).toLocaleDateString())}</td>
                        <td>${escapeHtml(row.created_by_user?.name || '—')}</td>
                        <td>${escapeHtml(new Date(row.created_at).toLocaleString())}</td>
                      </tr>`
                      )
                      .join('')}
                  </tbody>
                </table>`
      }
    </div>
  `;
}

function wireEvents(container, store, load) {
  container.querySelector('[data-action="retry"]')?.addEventListener('click', load);

  container.querySelector('[data-action="filter-item"]')?.addEventListener('change', (e) => {
    store.setState({ itemId: e.target.value });
    load();
  });

  // Same 'blur' + skip-segments date-field pattern as every filterable
  // date range in the app (see Action Log/Order Status) — re-rendering
  // mid-edit on a live 'change' would corrupt a date still being typed.
  const bindDateFilter = (selector, key) => {
    const input = container.querySelector(selector);
    if (!input) return;
    skipDateSegmentsOnTab(input);
    onRealBlur(input, (e) => {
      const value = e.target.value;
      afterFocusSettles(() => {
        store.setState({ [key]: value });
        load();
      });
    });
  };
  bindDateFilter('[data-action="filter-date-from"]', 'dateFrom');
  bindDateFilter('[data-action="filter-date-to"]', 'dateTo');
}
