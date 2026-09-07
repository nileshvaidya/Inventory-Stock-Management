// Stock Statement (Phase 12): a printable Rs. valuation of stock in hand,
// in a standard format suitable to submit to a bank — direct user
// request. Reads stock_valuation (see supabase/schema.sql), which values
// current_qty (physically on hand right now) at each item's current rate
// — reserved-for-a-work-order stock is still physically in the
// warehouse, so it counts, unlike the "available" figure Inventory/Work
// Orders use for planning. Admin/Authorized only: this is a finance
// document, not an operational stock screen (Inventory's own broader
// admin/store/production audience doesn't apply here), same role
// convention as Invoices/Bill Payments.
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
import { fetchStockValuation } from '../itemPricing.js';

const COMPANY_NAME = 'ASK Info-Solutions LLP';

function initialState() {
  return { rows: [], loading: true, error: false };
}

export async function render(container) {
  const user = await getCurrentProfile();
  if (!user) {
    window.location.hash = '#/login';
    return;
  }
  if (!canViewModule('/stock-statement', user.role)) {
    window.location.hash = '#/dashboard';
    return;
  }

  const content = renderShell(container, { activeRoute: '/stock-statement', user });
  content.setAttribute('data-screen', 'stock-statement');
  const store = createStore(initialState());

  async function load() {
    store.setState({ loading: true, error: false });
    try {
      const rows = await fetchStockValuation();
      store.setState({ rows, loading: false, error: false });
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

    ${
      state.loading
        ? `<div class="no-print" style="padding:20px;font-size:13px;color:var(--color-neutral-500)">Loading…</div>`
        : state.error
          ? `<div class="no-print card elev-sm" style="padding:20px;text-align:center">
              <p style="font-size:13px;color:var(--color-accent-2-200);margin:0 0 10px">Couldn't load the stock statement.</p>
              <button type="button" class="btn btn-secondary" data-action="retry">Retry</button>
            </div>`
          : renderSheet(state.rows)
    }
  `;
}

function renderSheet(rows) {
  const asOf = new Date().toLocaleDateString('en-IN', { day: '2-digit', month: 'long', year: 'numeric' });
  const priced = rows.filter((r) => r.stock_value !== null);
  const unpriced = rows.filter((r) => r.stock_value === null);
  const totalValue = priced.reduce((sum, r) => sum + Number(r.stock_value), 0);

  return `
    <div data-role="stock-statement-sheet" style="background:#fff;color:#111;max-width:900px;margin:0 auto;padding:32px;border:1px solid #d0d0d0;border-radius:4px;font-family:Georgia,'Times New Roman',serif">
      <div style="text-align:center;margin-bottom:24px;border-bottom:2px solid #111;padding-bottom:16px">
        <div style="font-size:20px;font-weight:700;letter-spacing:0.02em">${escapeHtml(COMPANY_NAME)}</div>
        <div style="font-size:13px;color:#444;margin-top:4px">Statement of Stock in Hand</div>
        <div style="font-size:13px;color:#444;margin-top:8px">As on: <strong>${escapeHtml(asOf)}</strong></div>
      </div>

      ${
        rows.length === 0
          ? `<p style="text-align:center;color:#666;font-size:13px">No items recorded yet.</p>`
          : `<table style="width:100%;border-collapse:collapse;font-size:13px" data-role="stock-statement-table">
              <thead>
                <tr style="border-bottom:2px solid #111">
                  <th style="text-align:left;padding:8px 6px">S.No</th>
                  <th style="text-align:left;padding:8px 6px">Item</th>
                  <th style="text-align:left;padding:8px 6px">Category</th>
                  <th style="text-align:left;padding:8px 6px">UoM</th>
                  <th style="text-align:right;padding:8px 6px">Qty on Hand</th>
                  <th style="text-align:right;padding:8px 6px">Rate (₹)</th>
                  <th style="text-align:right;padding:8px 6px">Value (₹)</th>
                </tr>
              </thead>
              <tbody>
                ${rows
                  .map(
                    (row, i) => `
                  <tr data-statement-row="${escapeHtml(row.item_id)}" style="border-bottom:1px solid #ddd">
                    <td style="padding:6px">${i + 1}</td>
                    <td style="padding:6px">${escapeHtml(row.name)}</td>
                    <td style="padding:6px">${escapeHtml(row.category || '—')}</td>
                    <td style="padding:6px">${escapeHtml(row.unit_of_measure || '—')}</td>
                    <td style="padding:6px;text-align:right">${row.current_qty}</td>
                    <td style="padding:6px;text-align:right">${row.rate !== null ? Number(row.rate).toFixed(2) : '—'}</td>
                    <td style="padding:6px;text-align:right">${row.stock_value !== null ? Number(row.stock_value).toFixed(2) : '—'}</td>
                  </tr>`
                  )
                  .join('')}
              </tbody>
              <tfoot>
                <tr style="border-top:2px solid #111;font-weight:700">
                  <td colspan="6" style="padding:10px 6px;text-align:right">Total Value of Stock in Hand</td>
                  <td style="padding:10px 6px;text-align:right" data-role="statement-total">₹${totalValue.toFixed(2)}</td>
                </tr>
              </tfoot>
            </table>
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
  `;
}

function wireEvents(container, store, load) {
  container.querySelector('[data-action="retry"]')?.addEventListener('click', load);
  container.querySelector('[data-action="print"]')?.addEventListener('click', () => window.print());
}
