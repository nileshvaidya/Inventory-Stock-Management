// Invoices (Phase 5): link invoices to one or more POs, track payment
// terms/due dates, and overdue status. Admin/Authorized only.
import { getCurrentProfile } from '../auth.js';
import { renderShell } from '../layout.js';
import { escapeHtml } from '../components.js';
import { createStore } from '../state.js';
import { canViewModule } from '../navPermissions.js';
import { fetchInvoices, createInvoice, markInvoicePaid, softDeleteInvoice, uploadBillFile, getBillFileUrl } from '../invoices.js';
import { fetchVendors } from '../vendors.js';
import { fetchPurchaseOrders } from '../purchaseOrders.js';
import { validateInvoiceForm } from '../validation.js';
import { toCsv, downloadCsv } from '../csvExport.js';
import { repaintPreservingFocus, afterFocusSettles } from '../domFocus.js';
import { extractPdfText, parseInvoiceNumber, parseInvoiceDate, parseInvoiceAmount } from '../pdfParser.js';

const todayISO = () => new Date().toISOString().slice(0, 10);

function addDays(dateStr, days) {
  if (!dateStr || days === '' || days === null || days === undefined) return '';
  const date = new Date(`${dateStr}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return '';
  date.setUTCDate(date.getUTCDate() + Number(days));
  return date.toISOString().slice(0, 10);
}

function invoiceStatus(invoice) {
  if (invoice.paid_at) return 'paid';
  if (invoice.due_date && invoice.due_date < todayISO()) return 'overdue';
  return 'pending';
}

const STATUS_LABELS = { paid: 'Paid', overdue: 'Overdue', pending: 'Pending' };
const STATUS_TAG_CLASSES = { paid: 'tag-accent', overdue: 'tag-accent-2', pending: 'tag-neutral' };

function initialFormState() {
  return {
    formOpen: false,
    vendorId: '',
    invoiceNumber: '',
    invoiceDate: todayISO(),
    paymentTermsDays: '',
    dueDate: '',
    amount: '',
    notes: '',
    selectedPoIds: [],
    saving: false,
    saveError: null,
    // The raw File object survives the state spread fine (setState only
    // shallow-merges) — kept until Save, since attaching it happens as a
    // separate step after the invoice row exists (uploadBillFile needs its
    // id for the storage path), same two-step shape as PO Upload's
    // create-then-link-line-items save.
    invoiceFile: null,
    invoiceFileName: '',
    invoiceParseNote: null,
    invoiceOcrBusy: false,
  };
}

export async function render(container) {
  const user = await getCurrentProfile();
  if (!user) {
    window.location.hash = '#/login';
    return;
  }
  if (!canViewModule('/invoices', user.role)) {
    window.location.hash = '#/dashboard';
    return;
  }

  const content = renderShell(container, { activeRoute: '/invoices', user });
  content.setAttribute('data-screen', 'invoices');
  const store = createStore({
    invoices: [],
    vendors: [],
    purchaseOrders: [],
    loading: true,
    error: false,
    vendorFilter: '',
    statusFilter: '',
    includeArchived: false,
    savedOk: false,
    fileBusyId: null,
    fileActionError: null,
    ...initialFormState(),
  });

  async function load() {
    store.setState({ loading: true, error: false });
    const s = store.getState();
    try {
      const invoices = await fetchInvoices({
        vendorId: s.vendorFilter || undefined,
        status: s.statusFilter || undefined,
        includeArchived: s.includeArchived,
      });
      store.setState({ invoices, loading: false, error: false });
    } catch {
      store.setState({ loading: false, error: true });
    }
  }

  function paint() {
    repaintPreservingFocus(content, () => {
      renderContent(content, store.getState());
      wireEvents(content, store, user, load);
    });
  }

  store.subscribe(paint);
  paint();
  const [vendors, purchaseOrders] = await Promise.all([fetchVendors(), fetchPurchaseOrders()]);
  store.setState({ vendors, purchaseOrders });
  await load();
}

function renderContent(container, state) {
  container.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;flex-wrap:wrap;gap:12px">
      <h1 style="margin:0">Invoices</h1>
      <div style="display:flex;gap:8px">
        <button type="button" class="btn btn-secondary" data-action="export-csv">Export CSV</button>
        <button type="button" class="btn btn-primary" data-action="toggle-form">${state.formOpen ? 'Cancel' : '+ New Invoice'}</button>
      </div>
    </div>

    ${state.savedOk ? `<p style="font-size:13px;color:var(--color-accent-100);background:var(--color-accent-900);border:1px solid var(--color-accent-700);border-radius:var(--radius-md);padding:8px 12px;margin-bottom:14px">Invoice saved.</p>` : ''}
    ${state.fileActionError ? `<p data-role="file-action-error" style="font-size:13px;color:var(--color-accent-2-200);background:var(--color-accent-2-900);border:1px solid var(--color-accent-2-700);border-radius:var(--radius-md);padding:8px 12px;margin-bottom:14px">${escapeHtml(state.fileActionError)}</p>` : ''}

    ${state.formOpen ? renderNewInvoiceCard(state) : ''}

    <div class="card elev-sm" style="margin-bottom:16px">
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;align-items:end">
        <div class="field"><label for="inv-filter-vendor">Vendor</label>
          <select class="input" id="inv-filter-vendor" data-action="filter-vendor">
            <option value="">All</option>
            ${state.vendors.map((v) => `<option value="${escapeHtml(v.id)}" ${state.vendorFilter === v.id ? 'selected' : ''}>${escapeHtml(v.name)}</option>`).join('')}
          </select>
        </div>
        <div class="field"><label for="inv-filter-status">Status</label>
          <select class="input" id="inv-filter-status" data-action="filter-status">
            <option value="">All</option>
            <option value="pending" ${state.statusFilter === 'pending' ? 'selected' : ''}>Pending</option>
            <option value="overdue" ${state.statusFilter === 'overdue' ? 'selected' : ''}>Overdue</option>
            <option value="paid" ${state.statusFilter === 'paid' ? 'selected' : ''}>Paid</option>
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
                <p style="font-size:13px;color:var(--color-accent-2-200);margin:0 0 10px">Couldn't load invoices.</p>
                <button type="button" class="btn btn-secondary" data-action="retry">Retry</button>
              </div>`
            : state.invoices.length === 0
              ? `<div style="padding:20px;font-size:13px;color:var(--color-neutral-500)">No invoices match these filters.</div>`
              : `<table class="table" style="min-width:900px">
                  <thead><tr><th>Invoice #</th><th>Vendor</th><th>Invoice Date</th><th>Due Date</th><th>Amount</th><th>Linked POs</th><th>Status</th><th>File</th><th></th></tr></thead>
                  <tbody>${state.invoices.map((invoice) => renderRow(invoice, state)).join('')}</tbody>
                </table>`
      }
    </div>
  `;
}

function renderNewInvoiceCard(state) {
  const vendorPOs = state.vendorId ? state.purchaseOrders.filter((po) => po.vendor_id === state.vendorId) : state.purchaseOrders;
  return `
    <div class="card elev-sm" style="margin-bottom:16px">
      <h3 class="card-title" style="font-size:16px">New Invoice</h3>
      ${state.saveError ? `<p data-role="save-error" style="font-size:13px;color:var(--color-accent-2-200);margin-top:8px">${escapeHtml(state.saveError)}</p>` : ''}

      <div class="field" style="margin-top:10px">
        <label for="inv-file">Upload Invoice (optional)</label>
        <input id="inv-file" type="file" accept="application/pdf,image/*" data-action="invoice-file" class="input" style="padding:6px" ${state.invoiceOcrBusy ? 'disabled' : ''} />
        ${state.invoiceFileName ? `<p style="font-size:12px;color:var(--color-neutral-500);margin-top:6px">Selected: ${escapeHtml(state.invoiceFileName)}</p>` : ''}
        ${state.invoiceOcrBusy ? `<p data-role="invoice-ocr-busy" style="font-size:12px;color:var(--color-neutral-500);margin-top:4px">Scanning document for invoice details… this can take up to a minute on a scanned/photographed file.</p>` : ''}
        ${!state.invoiceOcrBusy && state.invoiceParseNote ? `<p data-role="invoice-parse-note" style="font-size:12px;color:var(--color-neutral-500);margin-top:4px">${escapeHtml(state.invoiceParseNote)}</p>` : ''}
      </div>

      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;margin-top:10px">
        <div class="field"><label for="inv-vendor">Vendor</label>
          <select class="input" id="inv-vendor" data-action="form-vendor">
            <option value="">Select…</option>
            ${state.vendors.map((v) => `<option value="${escapeHtml(v.id)}" ${state.vendorId === v.id ? 'selected' : ''}>${escapeHtml(v.name)}</option>`).join('')}
          </select>
        </div>
        <div class="field"><label for="inv-number">Invoice Number (optional)</label>
          <input class="input" id="inv-number" data-action="form-invoice-number" value="${escapeHtml(state.invoiceNumber)}" />
        </div>
        <div class="field"><label for="inv-date">Invoice Date</label>
          <input class="input" id="inv-date" type="date" data-action="form-invoice-date" value="${escapeHtml(state.invoiceDate)}" />
        </div>
        <div class="field"><label for="inv-terms">Payment Terms (days, optional)</label>
          <input class="input" id="inv-terms" type="text" inputmode="numeric" data-action="form-payment-terms" value="${escapeHtml(state.paymentTermsDays)}" />
        </div>
        <div class="field"><label for="inv-due">Due Date (optional)</label>
          <input class="input" id="inv-due" type="date" data-action="form-due-date" value="${escapeHtml(state.dueDate)}" />
        </div>
        <div class="field"><label for="inv-amount">Amount</label>
          <input class="input" id="inv-amount" type="text" inputmode="decimal" data-action="form-amount" value="${escapeHtml(state.amount)}" />
        </div>
        <div class="field"><label for="inv-notes">Notes (optional)</label>
          <input class="input" id="inv-notes" data-action="form-notes" value="${escapeHtml(state.notes)}" />
        </div>
      </div>
      <div style="margin-top:12px">
        <label style="font-size:13px;font-weight:500">Link Purchase Orders (optional)</label>
        ${
          vendorPOs.length === 0
            ? `<p style="font-size:12px;color:var(--color-neutral-500);margin-top:4px">No purchase orders available to link.</p>`
            : `<div style="max-height:160px;overflow-y:auto;border:1px solid var(--color-divider);border-radius:var(--radius-md);margin-top:6px;padding:6px 10px">
                ${vendorPOs
                  .map(
                    (po) => `
                  <label style="display:flex;align-items:center;gap:8px;font-size:13px;padding:3px 0">
                    <input type="checkbox" data-action="form-po" value="${escapeHtml(po.id)}" ${state.selectedPoIds.includes(po.id) ? 'checked' : ''} />
                    ${escapeHtml(po.po_number || po.id.slice(0, 8))}
                  </label>`
                  )
                  .join('')}
              </div>`
        }
      </div>
      <button type="button" class="btn btn-primary" data-action="save-invoice" style="margin-top:12px" ${state.saving || state.invoiceOcrBusy ? 'disabled' : ''}>${state.saving ? 'Saving…' : 'Save Invoice'}</button>
    </div>
  `;
}

function renderRow(invoice, state) {
  const status = invoiceStatus(invoice);
  const archived = Boolean(invoice.deleted_at);
  const linkedPOs = (invoice.invoice_purchase_orders ?? []).map((link) => link.po?.po_number).filter(Boolean);
  const hasFile = Boolean(invoice.bill_file_path);
  const fileBusy = state.fileBusyId === invoice.id;
  return `
    <tr data-invoice-row="${escapeHtml(invoice.id)}" style="${archived ? 'opacity:0.55' : ''}">
      <td>${escapeHtml(invoice.invoice_number || '—')}</td>
      <td>${escapeHtml(invoice.vendor?.name || '—')}</td>
      <td>${escapeHtml(invoice.invoice_date)}</td>
      <td>${escapeHtml(invoice.due_date || '—')}</td>
      <td>${Number(invoice.amount).toFixed(2)}</td>
      <td>${linkedPOs.length > 0 ? escapeHtml(linkedPOs.join(', ')) : '—'}</td>
      <td><span class="tag ${STATUS_TAG_CLASSES[status]}">${STATUS_LABELS[status]}</span>${archived ? ' (archived)' : ''}</td>
      <td style="white-space:nowrap">
        ${
          archived
            ? hasFile
              ? `<button type="button" class="btn btn-ghost" data-action="view-invoice-file" data-path="${escapeHtml(invoice.bill_file_path)}" style="padding:4px 10px;font-size:12px">View</button>`
              : '—'
            : `<label class="btn btn-secondary" style="padding:4px 10px;font-size:12px;cursor:pointer;display:inline-block">
                 ${hasFile ? 'Replace' : 'Attach'}
                 <input type="file" accept="application/pdf,image/*" data-action="invoice-file-attach" data-id="${escapeHtml(invoice.id)}" style="display:none" ${fileBusy ? 'disabled' : ''} />
               </label>
               ${hasFile ? `<button type="button" class="btn btn-ghost" data-action="view-invoice-file" data-path="${escapeHtml(invoice.bill_file_path)}" style="padding:4px 10px;font-size:12px">View</button>` : ''}`
        }
      </td>
      <td style="white-space:nowrap">
        ${
          archived
            ? ''
            : `${status !== 'paid' ? `<button type="button" class="btn btn-secondary" data-action="mark-paid" data-id="${escapeHtml(invoice.id)}" style="padding:4px 10px;font-size:12px">Mark Paid</button>` : ''}
               <button type="button" class="btn btn-ghost" data-action="delete-invoice" data-id="${escapeHtml(invoice.id)}" style="padding:4px 10px;font-size:12px">Delete</button>`
        }
      </td>
    </tr>`;
}

function wireEvents(container, store, user, load) {
  const bindFilter = (selector, key) => {
    container.querySelector(selector)?.addEventListener('change', (e) => {
      store.setState({ [key]: e.target.value });
      load();
    });
  };
  bindFilter('[data-action="filter-vendor"]', 'vendorFilter');
  bindFilter('[data-action="filter-status"]', 'statusFilter');
  container.querySelector('[data-action="filter-archived"]')?.addEventListener('change', (e) => {
    store.setState({ includeArchived: e.target.checked });
    load();
  });
  container.querySelector('[data-action="retry"]')?.addEventListener('click', load);

  container.querySelector('[data-action="toggle-form"]')?.addEventListener('click', () => {
    const state = store.getState();
    store.setState(state.formOpen ? { formOpen: false } : { ...initialFormState(), formOpen: true, savedOk: false });
  });

  container.querySelector('[data-action="invoice-file"]')?.addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const state = store.getState();
    store.setState({ invoiceFile: file, invoiceFileName: file.name, invoiceParseNote: null });

    let invoiceNumber = null;
    let invoiceDate = null;
    let amount = null;
    let readFailed = false;

    if (file.type === 'application/pdf') {
      try {
        const text = await extractPdfText(file);
        invoiceNumber = parseInvoiceNumber(text);
        invoiceDate = parseInvoiceDate(text);
        amount = parseInvoiceAmount(text);
      } catch {
        readFailed = true;
      }
    }

    // Nothing found yet (a scanned/photographed PDF with no text layer, a
    // plain image file, or a PDF read failure) — fall back to OCR before
    // giving up and asking for manual entry. OCR is slow, so this is only
    // attempted once the fast, free path has already come up empty.
    if (!readFailed && invoiceNumber === null && invoiceDate === null && amount === null) {
      store.setState({ invoiceOcrBusy: true });
      // Dynamically imported — OCR (tesseract.js) is a sizeable dependency
      // only worth fetching once a document actually needs this fallback,
      // not on every visit to this screen.
      const { ocrFile } = await import('../ocr.js');
      const ocrText = await ocrFile(file);
      // The user may have picked a different file while OCR was running —
      // don't clobber it with this stale result.
      if (store.getState().invoiceFile !== file) return;
      store.setState({ invoiceOcrBusy: false });
      if (ocrText) {
        invoiceNumber = parseInvoiceNumber(ocrText);
        invoiceDate = parseInvoiceDate(ocrText);
        amount = parseInvoiceAmount(ocrText);
      }
    }

    const foundAnything = invoiceNumber !== null || invoiceDate !== null || amount !== null;
    store.setState({
      invoiceNumber: invoiceNumber ?? state.invoiceNumber,
      invoiceDate: invoiceDate ?? state.invoiceDate,
      dueDate: addDays(invoiceDate ?? state.invoiceDate, state.paymentTermsDays) || state.dueDate,
      amount: amount !== null ? String(amount) : state.amount,
      invoiceParseNote: readFailed
        ? "Couldn't read this PDF — enter the invoice's details by hand below."
        : foundAnything
          ? null
          : "Couldn't auto-detect invoice details from this file — enter them by hand below.",
    });
  });

  container.querySelector('[data-action="form-vendor"]')?.addEventListener('change', (e) => {
    const state = store.getState();
    const vendor = state.vendors.find((v) => v.id === e.target.value);
    const paymentTermsDays = vendor?.default_payment_terms_days ?? state.paymentTermsDays;
    store.setState({
      vendorId: e.target.value,
      paymentTermsDays,
      dueDate: addDays(state.invoiceDate, paymentTermsDays) || state.dueDate,
      selectedPoIds: [],
    });
  });
  container.querySelector('[data-action="form-invoice-number"]')?.addEventListener('input', (e) => store.setState({ invoiceNumber: e.target.value }));
  // 'blur' rather than 'input'/'change': a native date picker's in-progress
  // segment (day/month/year) lives in the browser's own internal editing
  // state, which a full re-render (this screen's paint(), on every
  // store.setState) can't preserve the way repaintPreservingFocus does for
  // a text input's cursor position — re-rendering mid-edit silently wipes
  // whatever segment the user was typing. Chrome fires 'change' on this
  // element type on every completed segment, not just once at the end (as
  // was assumed in an earlier, insufficient fix here), so it re-renders
  // mid-edit just as often as 'input' did. 'blur' only fires once, after
  // the user is done with the field entirely, so no re-render ever
  // interrupts an in-progress edit. The setState itself is deferred via
  // afterFocusSettles: calling it synchronously inside 'blur' raced the
  // browser's own Tab-driven focus transfer and broke Tab navigation out
  // of this field — see domFocus.js.
  container.querySelector('[data-action="form-invoice-date"]')?.addEventListener('blur', (e) => {
    const value = e.target.value;
    afterFocusSettles(() => {
      const state = store.getState();
      store.setState({ invoiceDate: value, dueDate: addDays(value, state.paymentTermsDays) || state.dueDate });
    });
  });
  container.querySelector('[data-action="form-payment-terms"]')?.addEventListener('input', (e) => {
    const state = store.getState();
    store.setState({ paymentTermsDays: e.target.value, dueDate: addDays(state.invoiceDate, e.target.value) || state.dueDate });
  });
  container.querySelector('[data-action="form-due-date"]')?.addEventListener('blur', (e) => {
    const value = e.target.value;
    afterFocusSettles(() => store.setState({ dueDate: value }));
  });
  container.querySelector('[data-action="form-amount"]')?.addEventListener('input', (e) => store.setState({ amount: e.target.value }));
  container.querySelector('[data-action="form-notes"]')?.addEventListener('input', (e) => store.setState({ notes: e.target.value }));

  container.querySelectorAll('[data-action="form-po"]').forEach((el) => {
    el.addEventListener('change', () => {
      const state = store.getState();
      const selectedPoIds = el.checked
        ? [...state.selectedPoIds, el.value]
        : state.selectedPoIds.filter((id) => id !== el.value);
      store.setState({ selectedPoIds });
    });
  });

  container.querySelector('[data-action="save-invoice"]')?.addEventListener('click', async () => {
    const state = store.getState();
    const { valid, errors } = validateInvoiceForm(state);
    if (!valid) {
      store.setState({ saveError: Object.values(errors)[0] });
      return;
    }

    store.setState({ saving: true, saveError: null });
    try {
      const invoice = await createInvoice({
        invoiceNumber: state.invoiceNumber,
        vendorId: state.vendorId,
        invoiceDate: state.invoiceDate,
        paymentTermsDays: state.paymentTermsDays === '' ? null : Number(state.paymentTermsDays),
        dueDate: state.dueDate,
        amount: Number(state.amount),
        notes: state.notes,
        createdBy: user.id,
        poIds: state.selectedPoIds,
      });
      if (state.invoiceFile) {
        try {
          await uploadBillFile(invoice.id, state.invoiceFile);
        } catch {
          // The invoice itself is already saved — a failed attach is a
          // secondary, correctable problem (Attach/Replace is also right
          // here in the list below), never a reason to make the whole
          // save look like it failed.
        }
      }
      store.setState({ ...initialFormState(), savedOk: true });
      await load();
    } catch (err) {
      store.setState({ saving: false, saveError: err.message || 'Could not save this invoice.' });
    }
  });

  container.querySelectorAll('[data-action="invoice-file-attach"]').forEach((input) => {
    input.addEventListener('change', async (e) => {
      const file = e.target.files?.[0];
      const id = input.dataset.id;
      if (!file) return;
      store.setState({ fileBusyId: id, fileActionError: null });
      try {
        await uploadBillFile(id, file);
        await load();
        store.setState({ fileBusyId: null });
      } catch (err) {
        store.setState({ fileBusyId: null, fileActionError: err.message || 'Could not upload this file.' });
      }
    });
  });

  container.querySelectorAll('[data-action="view-invoice-file"]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      try {
        const url = await getBillFileUrl(btn.dataset.path);
        if (url) window.open(url, '_blank', 'noopener');
      } catch (err) {
        store.setState({ fileActionError: err.message || 'Could not open this file.' });
      }
    });
  });

  container.querySelectorAll('[data-action="mark-paid"]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      await markInvoicePaid(btn.dataset.id);
      await load();
    });
  });

  container.querySelectorAll('[data-action="delete-invoice"]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!window.confirm('Archive this invoice?')) return;
      await softDeleteInvoice(btn.dataset.id);
      await load();
    });
  });

  container.querySelector('[data-action="export-csv"]')?.addEventListener('click', () => {
    const { invoices } = store.getState();
    const csv = toCsv(
      invoices.map((invoice) => ({
        invoice_number: invoice.invoice_number || '',
        vendor: invoice.vendor?.name || '',
        invoice_date: invoice.invoice_date,
        due_date: invoice.due_date || '',
        amount: Number(invoice.amount).toFixed(2),
        linked_pos: (invoice.invoice_purchase_orders ?? []).map((link) => link.po?.po_number).filter(Boolean).join('; '),
        status: STATUS_LABELS[invoiceStatus(invoice)],
      })),
      [
        { key: 'invoice_number', header: 'Invoice Number' },
        { key: 'vendor', header: 'Vendor' },
        { key: 'invoice_date', header: 'Invoice Date' },
        { key: 'due_date', header: 'Due Date' },
        { key: 'amount', header: 'Amount' },
        { key: 'linked_pos', header: 'Linked POs' },
        { key: 'status', header: 'Status' },
      ]
    );
    downloadCsv(csv, `invoices-${todayISO()}.csv`);
  });
}
