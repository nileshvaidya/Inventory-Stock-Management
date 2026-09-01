// Bill Payments (Phase 10). Confirmed with the user before building:
// "Bill" and "Invoice" are the same record, not a separate entity — Phase
// 5 already gives Invoices a complete paid/overdue lifecycle, so this
// screen doesn't create or duplicate invoice data (that stays on the
// Invoices screen). The one capability Phase 5 didn't have is the scanned
// bill document itself (see uploadBillFile/getBillFileUrl/removeBillFile
// in ../invoices.js), so this is a purpose-built, narrower workflow over
// the same invoices data: attach/view/remove the bill file and mark it
// received on payment. Restricted to the 'authorized' role only (not
// admin — see src/navPermissions.js), unlike the broader Admin/Authorized
// Invoices screen; three other layers (nav, route guard, Help content)
// were already built in Phase 0/1.
import { getCurrentProfile } from '../auth.js';
import { renderShell } from '../layout.js';
import { escapeHtml } from '../components.js';
import { createStore } from '../state.js';
import { canViewModule } from '../navPermissions.js';
import { fetchInvoices, markInvoicePaid, uploadBillFile, getBillFileUrl, removeBillFile } from '../invoices.js';

const todayISO = () => new Date().toISOString().slice(0, 10);

function billStatus(invoice) {
  if (invoice.paid_at) return 'received';
  if (invoice.due_date && invoice.due_date < todayISO()) return 'overdue';
  return 'pending';
}

const STATUS_LABELS = { received: 'Received', overdue: 'Overdue', pending: 'Pending' };
const STATUS_TAG_CLASSES = { received: 'tag-accent', overdue: 'tag-accent-2', pending: 'tag-neutral' };

export async function render(container) {
  const user = await getCurrentProfile();
  if (!user) {
    window.location.hash = '#/login';
    return;
  }
  if (!canViewModule('/bill-payments', user.role)) {
    window.location.hash = '#/dashboard';
    return;
  }

  const content = renderShell(container, { activeRoute: '/bill-payments', user });
  content.setAttribute('data-screen', 'bill-payments');
  const store = createStore({
    invoices: [],
    loading: true,
    error: false,
    statusFilter: '',
    busyId: null,
    actionError: null,
  });

  async function load() {
    store.setState({ loading: true, error: false });
    const s = store.getState();
    try {
      const invoices = await fetchInvoices({ status: s.statusFilter || undefined });
      store.setState({ invoices, loading: false, error: false });
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
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;flex-wrap:wrap;gap:12px">
      <h1 style="margin:0">Bill Payments</h1>
    </div>

    <p style="font-size:13px;color:var(--color-neutral-500);margin:0 0 16px">
      Attach a scanned bill to an invoice and mark it received once paid. To create a new invoice or link it to POs, use Invoices.
    </p>

    ${state.actionError ? `<p data-role="action-error" style="font-size:13px;color:var(--color-accent-2-200);background:var(--color-accent-2-900,transparent);border:1px solid var(--color-accent-2-700,var(--color-divider));border-radius:var(--radius-md);padding:8px 12px;margin-bottom:14px">${escapeHtml(state.actionError)}</p>` : ''}

    <div class="card elev-sm" style="margin-bottom:16px">
      <div class="field" style="max-width:220px">
        <label for="bp-filter-status">Status</label>
        <select class="input" id="bp-filter-status" data-action="filter-status">
          <option value="">All</option>
          <option value="pending" ${state.statusFilter === 'pending' ? 'selected' : ''}>Pending</option>
          <option value="overdue" ${state.statusFilter === 'overdue' ? 'selected' : ''}>Overdue</option>
          <option value="paid" ${state.statusFilter === 'paid' ? 'selected' : ''}>Received</option>
        </select>
      </div>
    </div>

    <div class="card elev-sm" style="padding:0;overflow-x:auto">
      ${
        state.loading
          ? `<div style="padding:20px;font-size:13px;color:var(--color-neutral-500)">Loading…</div>`
          : state.error
            ? `<div style="padding:20px;text-align:center">
                <p style="font-size:13px;color:var(--color-accent-2-200);margin:0 0 10px">Couldn't load invoices.</p>
                <button type="button" class="btn btn-secondary" data-action="retry">Retry</button>
              </div>`
            : state.invoices.length === 0
              ? `<div style="padding:20px;font-size:13px;color:var(--color-neutral-500)">No invoices match these filters.</div>`
              : `<table class="table" style="min-width:760px">
                  <thead><tr><th>Invoice #</th><th>Vendor</th><th>Due Date</th><th>Amount</th><th>Status</th><th>Bill File</th><th></th></tr></thead>
                  <tbody>${state.invoices.map((invoice) => renderRow(invoice, state)).join('')}</tbody>
                </table>`
      }
    </div>
  `;
}

function renderRow(invoice, state) {
  const status = billStatus(invoice);
  const hasBill = Boolean(invoice.bill_file_path);
  const busy = state.busyId === invoice.id;
  return `
    <tr data-invoice-row="${escapeHtml(invoice.id)}">
      <td>${escapeHtml(invoice.invoice_number || '—')}</td>
      <td>${escapeHtml(invoice.vendor?.name || '—')}</td>
      <td>${escapeHtml(invoice.due_date || '—')}</td>
      <td>${Number(invoice.amount).toFixed(2)}</td>
      <td><span class="tag ${STATUS_TAG_CLASSES[status]}">${STATUS_LABELS[status]}</span></td>
      <td data-role="bill-file" style="font-size:12px;color:var(--color-neutral-500)">${hasBill ? escapeHtml(invoice.bill_file_name || 'Attached') : 'No file'}</td>
      <td style="white-space:nowrap">
        <label class="btn btn-secondary" style="padding:4px 10px;font-size:12px;cursor:pointer;display:inline-block">
          ${hasBill ? 'Replace' : 'Attach'}
          <input type="file" accept="application/pdf,image/*" data-action="bill-file" data-id="${escapeHtml(invoice.id)}" style="display:none" ${busy ? 'disabled' : ''} />
        </label>
        ${
          hasBill
            ? `<button type="button" class="btn btn-ghost" data-action="view-bill" data-path="${escapeHtml(invoice.bill_file_path)}" style="padding:4px 10px;font-size:12px">View</button>
               <button type="button" class="btn btn-ghost" data-action="remove-bill" data-id="${escapeHtml(invoice.id)}" data-path="${escapeHtml(invoice.bill_file_path)}" style="padding:4px 10px;font-size:12px" ${busy ? 'disabled' : ''}>Remove</button>`
            : ''
        }
        ${status !== 'received' ? `<button type="button" class="btn btn-primary" data-action="mark-received" data-id="${escapeHtml(invoice.id)}" style="padding:4px 10px;font-size:12px" ${busy ? 'disabled' : ''}>Mark Received</button>` : ''}
      </td>
    </tr>`;
}

function wireEvents(container, store, load) {
  container.querySelector('[data-action="retry"]')?.addEventListener('click', load);

  container.querySelector('[data-action="filter-status"]')?.addEventListener('change', (e) => {
    store.setState({ statusFilter: e.target.value });
    load();
  });

  container.querySelectorAll('[data-action="bill-file"]').forEach((input) => {
    input.addEventListener('change', async (e) => {
      const file = e.target.files?.[0];
      const id = input.dataset.id;
      if (!file) return;
      store.setState({ busyId: id, actionError: null });
      try {
        await uploadBillFile(id, file);
        await load();
      } catch (err) {
        store.setState({ busyId: null, actionError: err.message || 'Could not upload this file.' });
      }
    });
  });

  container.querySelectorAll('[data-action="view-bill"]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      try {
        const url = await getBillFileUrl(btn.dataset.path);
        if (url) window.open(url, '_blank', 'noopener');
      } catch (err) {
        store.setState({ actionError: err.message || 'Could not open this file.' });
      }
    });
  });

  container.querySelectorAll('[data-action="remove-bill"]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!window.confirm('Remove the attached bill file?')) return;
      const id = btn.dataset.id;
      store.setState({ busyId: id, actionError: null });
      try {
        await removeBillFile(id, btn.dataset.path);
        await load();
      } catch (err) {
        store.setState({ busyId: null, actionError: err.message || 'Could not remove this file.' });
      }
    });
  });

  container.querySelectorAll('[data-action="mark-received"]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.id;
      store.setState({ busyId: id, actionError: null });
      try {
        await markInvoicePaid(id);
        await load();
      } catch (err) {
        store.setState({ busyId: null, actionError: err.message || 'Could not mark this invoice received.' });
      }
    });
  });
}
