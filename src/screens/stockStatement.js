// Stock Statement (Phase 12): a printable Rs. valuation of stock in hand,
// in a standard format suitable to submit to a bank — direct user
// request. Reads stock_statement_for_range (see supabase/schema.sql),
// which computes Opening/Inward/Outward/Closing quantities for a chosen
// date range and values Closing Qty at whichever rate was in effect on
// dateTo — matching the reference statement's own format (Item Code,
// Category RM/WIP/FG, Vendor/Source, Opening/Inward/Outward/Closing Qty,
// Stock Location) rather than the earlier "current stock right now" view.
// Admin/Authorized only: this is a finance document, not an operational
// stock screen (Inventory's own broader admin/store/production audience
// doesn't apply here), same role convention as Invoices/Bill Payments.
//
// The printable block below is deliberately NOT built from this app's
// usual .card/.table classes — those lean on dark-theme CSS custom
// properties that a browser's print pipeline has no reason to invert, so
// a plain @media print { background: white } would still leave
// light-on-dark text unreadable on paper. Every color/border here is
// explicit and print-safe by construction instead.
import { getCurrentProfile } from '../auth.js';
import { renderShell } from '../layout.js';
import { escapeHtml } from '../components.js';
import { createStore } from '../state.js';
import { canViewModule } from '../navPermissions.js';
import { fetchStockStatement } from '../itemPricing.js';
import { itemTypeLabel } from '../itemType.js';
import { repaintPreservingFocus, afterFocusSettles, skipDateSegmentsOnTab, onRealBlur } from '../domFocus.js';
import { fetchRolePermissionsGuarded } from '../rolePermissions.js';

const COMPANY_NAME = 'ASK Info-Solutions LLP';

const todayISO = () => new Date().toISOString().slice(0, 10);
const firstOfMonthISO = () => {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), 1).toISOString().slice(0, 10);
};

function formatDisplayDate(iso) {
  if (!iso) return '—';
  return new Date(`${iso}T00:00:00`).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

function initialState() {
  return { rows: [], loading: true, error: false, dateFrom: firstOfMonthISO(), dateTo: todayISO() };
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
  if (!canViewModule('/stock-statement', user.role, rolePermissions)) {
    window.location.hash = '#/dashboard';
    return;
  }

  const content = await renderShell(container, { activeRoute: '/stock-statement', user, rolePermissions });
  content.setAttribute('data-screen', 'stock-statement');
  const store = createStore(initialState());

  async function load() {
    store.setState({ loading: true, error: false });
    const s = store.getState();
    try {
      const rows = await fetchStockStatement({ dateFrom: s.dateFrom, dateTo: s.dateTo });
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
  await load();
}

function renderContent(container, state) {
  container.innerHTML = `
    <style>
      /* Hides every part of the app shell except this screen's own
         content — see layout.js's renderShell for the wrapper structure
         (.min-h-screen > aside, the mobile top bar, main, the mobile
         bottom nav). Print is document-wide regardless of where in the
         DOM this <style> tag sits, so this reaches siblings/ancestors
         outside this screen's own root even though it's written here. */
      @media print {
        body { background: #fff !important; }
        .min-h-screen > *:not(main) { display: none !important; }
        .min-h-screen, main[data-role="content"] { display: block !important; width: 100% !important; padding: 0 !important; margin: 0 !important; }
        .no-print { display: none !important; }
        [data-role="stock-statement-sheet"] { box-shadow: none !important; border: none !important; }
      }
    </style>

    <div class="no-print" style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;flex-wrap:wrap;gap:12px">
      <h1 style="margin:0">Stock Statement</h1>
      ${!state.loading && !state.error ? `<button type="button" class="btn btn-primary" data-action="print">Print</button>` : ''}
    </div>

    <div class="no-print card elev-sm" style="margin-bottom:16px">
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px">
        <div class="field"><label for="ss-filter-date-from">From</label>
          <input class="input" id="ss-filter-date-from" type="date" data-action="filter-date-from" value="${escapeHtml(state.dateFrom)}" />
        </div>
        <div class="field"><label for="ss-filter-date-to">To</label>
          <input class="input" id="ss-filter-date-to" type="date" data-action="filter-date-to" value="${escapeHtml(state.dateTo)}" />
        </div>
      </div>
    </div>

    ${
      state.loading
        ? `<div class="no-print" style="padding:20px;font-size:13px;color:var(--color-neutral-500)">Loading…</div>`
        : state.error
          ? `<div class="no-print card elev-sm" style="padding:20px;text-align:center">
              <p style="font-size:13px;color:var(--color-accent-2-200);margin:0 0 10px">Couldn't load the stock statement.</p>
              <button type="button" class="btn btn-secondary" data-action="retry">Retry</button>
            </div>`
          : renderSheet(state.rows, state.dateFrom, state.dateTo)
    }
  `;
}

function renderSheet(rows, dateFrom, dateTo) {
  const priced = rows.filter((r) => r.stock_value !== null);
  const unpriced = rows.filter((r) => r.stock_value === null);
  const totalValue = priced.reduce((sum, r) => sum + Number(r.stock_value), 0);

  return `
    <div data-role="stock-statement-sheet" style="background:#fff;color:#111;max-width:1100px;margin:0 auto;border:1px solid #d0d0d0;border-radius:4px;overflow:hidden;font-family:Georgia,'Times New Roman',serif">
      <div style="background:#9c1458;color:#fff;text-align:center;padding:14px 20px">
        <div style="font-size:20px;font-weight:700;letter-spacing:0.02em">${escapeHtml(COMPANY_NAME)}</div>
        <div style="font-size:13px;margin-top:2px">Statement of Stock in Hand</div>
      </div>
      <div style="text-align:center;padding:10px 20px;border-bottom:2px solid #111;font-size:13px;color:#444">
        Period: <strong>${escapeHtml(formatDisplayDate(dateFrom))}</strong> to <strong>${escapeHtml(formatDisplayDate(dateTo))}</strong>
      </div>

      <div style="padding:24px">
      ${
        rows.length === 0
          ? `<p style="text-align:center;color:#666;font-size:13px">No items recorded yet.</p>`
          : `<div style="overflow-x:auto">
            <table style="width:100%;border-collapse:collapse;font-size:12px" data-role="stock-statement-table">
              <thead>
                <tr style="border-bottom:2px solid #111">
                  <th style="text-align:left;padding:8px 6px">Item Code</th>
                  <th style="text-align:left;padding:8px 6px">Item Description</th>
                  <th style="text-align:left;padding:8px 6px">Category</th>
                  <th style="text-align:left;padding:8px 6px">Vendor / Source</th>
                  <th style="text-align:right;padding:8px 6px">Opening Qty</th>
                  <th style="text-align:right;padding:8px 6px">Inward Qty</th>
                  <th style="text-align:right;padding:8px 6px">Outward Qty</th>
                  <th style="text-align:right;padding:8px 6px">Closing Qty</th>
                  <th style="text-align:left;padding:8px 6px">UoM</th>
                  <th style="text-align:right;padding:8px 6px">Rate/Unit (₹)</th>
                  <th style="text-align:right;padding:8px 6px">Closing Value (₹)</th>
                  <th style="text-align:left;padding:8px 6px">Location</th>
                </tr>
              </thead>
              <tbody>
                ${rows
                  .map(
                    (row) => `
                  <tr data-statement-row="${escapeHtml(row.item_id)}" style="border-bottom:1px solid #ddd">
                    <td style="padding:6px">${escapeHtml(row.item_code || '—')}</td>
                    <td style="padding:6px">${escapeHtml(row.name)}</td>
                    <td style="padding:6px">${escapeHtml(row.item_type ? itemTypeLabel(row.item_type) : '—')}</td>
                    <td style="padding:6px">${escapeHtml(row.source || '—')}</td>
                    <td style="padding:6px;text-align:right">${row.opening_qty}</td>
                    <td style="padding:6px;text-align:right">${row.inward_qty}</td>
                    <td style="padding:6px;text-align:right">${row.outward_qty}</td>
                    <td style="padding:6px;text-align:right">${row.closing_qty}</td>
                    <td style="padding:6px">${escapeHtml(row.unit_of_measure || '—')}</td>
                    <td style="padding:6px;text-align:right">${row.rate !== null ? Number(row.rate).toFixed(2) : '—'}</td>
                    <td style="padding:6px;text-align:right">${row.stock_value !== null ? Number(row.stock_value).toFixed(2) : '—'}</td>
                    <td style="padding:6px">${escapeHtml(row.location || '—')}</td>
                  </tr>`
                  )
                  .join('')}
              </tbody>
              <tfoot>
                <tr style="border-top:2px solid #111;font-weight:700">
                  <td colspan="10" style="padding:10px 6px;text-align:right">Total Value of Closing Stock</td>
                  <td style="padding:10px 6px;text-align:right" data-role="statement-total">₹${totalValue.toFixed(2)}</td>
                  <td></td>
                </tr>
              </tfoot>
            </table>
            </div>
            ${
              unpriced.length > 0
                ? `<p style="font-size:11px;color:#666;margin-top:10px" data-role="statement-unpriced-note">
                    Note: ${unpriced.length} item(s) have no unit rate on record and are excluded from the total above — see Price History to add one.
                  </p>`
                : ''
            }`
      }

      <div style="display:flex;justify-content:space-between;gap:40px;margin-top:56px">
        <div style="flex:1;text-align:center">
          <div style="border-top:1px solid #111;padding-top:6px;font-size:12px">Prepared By</div>
        </div>
        <div style="flex:1;text-align:center">
          <div style="border-top:1px solid #111;padding-top:6px;font-size:12px">Authorized Signatory &amp; Seal</div>
        </div>
      </div>
      </div>
    </div>
  `;
}

function wireEvents(container, store, load) {
  container.querySelector('[data-action="retry"]')?.addEventListener('click', load);
  container.querySelector('[data-action="print"]')?.addEventListener('click', () => window.print());

  // Same 'blur' + skip-segments date-field pattern as every filterable
  // date range in the app (see Price History/Action Log) — re-rendering
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
