// Material Dispatch (Phase 11): dispatch material out — scan a delivery
// challan (or enter by hand) to pick what's being dispatched, same
// upload-and-scan pattern as Material Inward/PO Upload/Invoices, including
// the OCR fallback for a scanned/photographed challan. Store/admin can
// create a dispatch record, but it never moves stock by itself — only an
// admin authorizing it does (authorize_material_dispatch(), atomically
// deducting every line item — see supabase/schema.sql), matching the
// direct request that inventory deduction wait for admin sign-off.
// Payment tracking (received/received date) is admin-only, both to view
// and to act on.
import { getCurrentProfile } from '../auth.js';
import { renderShell } from '../layout.js';
import { escapeHtml } from '../components.js';
import { createStore } from '../state.js';
import { canViewModule } from '../navPermissions.js';
import {
  fetchMaterialDispatches,
  createMaterialDispatch,
  uploadDispatchChallanFile,
  getDispatchChallanFileUrl,
  authorizeMaterialDispatch,
  markDispatchPaymentReceived,
} from '../materialDispatch.js';
import { fetchItems } from '../items.js';
import { validateMaterialDispatchForm } from '../validation.js';
import { repaintPreservingFocus, afterFocusSettles, skipDateSegmentsOnTab, onRealBlur } from '../domFocus.js';
import { extractPdfText, parseChallanText } from '../pdfParser.js';

const todayISO = () => new Date().toISOString().slice(0, 10);

function emptyLineItem() {
  return { itemId: '', quantity: '' };
}

function emptyForm() {
  return {
    dispatchDate: todayISO(),
    reference: '',
    notes: '',
    lineItems: [emptyLineItem()],
    challanFile: null,
    challanFileName: '',
    challanParseNote: null,
    challanOcrBusy: false,
  };
}

function initialState() {
  return {
    dispatches: [],
    items: [],
    loading: true,
    error: false,
    formMode: false,
    form: emptyForm(),
    formError: null,
    saving: false,
    openDispatchId: null,
    authorizingId: null,
    authorizeErrorByDispatch: {},
    markingPaymentId: null,
    paymentErrorByDispatch: {},
    fileActionError: null,
  };
}

/**
 * Matches parsed challan lines (item name + quantity) to the Item Master
 * by (trimmed, case-insensitive) name — same matching discipline as
 * Material Inward's matchChallanToLineItems, just against the whole Item
 * Master here instead of one PO's line items, since a dispatch isn't
 * fulfilling any particular PO.
 * @param {{ itemName: string, quantity: number }[]} parsedRows
 * @param {{ id: string, name: string }[]} items
 */
function matchChallanToItems(parsedRows, items) {
  const matchedLineItems = [];
  let matchedCount = 0;
  for (const row of parsedRows) {
    const target = items.find((it) => it.name.trim().toLowerCase() === row.itemName.trim().toLowerCase());
    if (target) {
      matchedLineItems.push({ itemId: target.id, quantity: String(row.quantity) });
      matchedCount += 1;
    }
  }
  return { matchedLineItems, matchedCount, totalParsed: parsedRows.length };
}

export async function render(container) {
  const user = await getCurrentProfile();
  if (!user) {
    window.location.hash = '#/login';
    return;
  }
  if (!canViewModule('/material-dispatch', user.role)) {
    window.location.hash = '#/dashboard';
    return;
  }
  const canCreate = user.role === 'admin' || user.role === 'store';
  const isAdmin = user.role === 'admin';

  const content = renderShell(container, { activeRoute: '/material-dispatch', user });
  content.setAttribute('data-screen', 'material-dispatch');
  const store = createStore(initialState());

  async function load() {
    store.setState({ loading: true, error: false });
    try {
      const [dispatches, items] = await Promise.all([fetchMaterialDispatches(), fetchItems()]);
      store.setState({ dispatches, items, loading: false, error: false });
    } catch {
      store.setState({ loading: false, error: true });
    }
  }

  function paint() {
    repaintPreservingFocus(content, () => {
      renderContent(content, store.getState(), canCreate, isAdmin);
      wireEvents(content, store, user, load, canCreate, isAdmin);
    });
  }

  store.subscribe(paint);
  paint();
  await load();
}

function renderContent(container, state, canCreate, isAdmin) {
  container.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;flex-wrap:wrap;gap:12px">
      <h1 style="margin:0">Material Dispatch</h1>
      ${canCreate && !state.formMode ? `<button type="button" class="btn btn-secondary" data-action="new-dispatch">+ New Dispatch</button>` : ''}
    </div>

    ${state.fileActionError ? `<p data-role="file-action-error" style="font-size:13px;color:var(--color-accent-2-200);background:var(--color-accent-2-900);border:1px solid var(--color-accent-2-700);border-radius:var(--radius-md);padding:8px 12px;margin-bottom:14px">${escapeHtml(state.fileActionError)}</p>` : ''}

    ${state.formMode ? renderForm(state) : ''}

    <div class="card elev-sm" style="padding:0;overflow-x:auto">
      ${
        state.loading
          ? `<div style="padding:20px;font-size:13px;color:var(--color-neutral-500)">Loading…</div>`
          : state.error
            ? `<div style="padding:20px;text-align:center">
                <p style="font-size:13px;color:var(--color-accent-2-200);margin:0 0 10px">Couldn't load material dispatch records.</p>
                <button type="button" class="btn btn-secondary" data-action="retry">Retry</button>
              </div>`
            : state.dispatches.length === 0
              ? `<div style="padding:20px;font-size:13px;color:var(--color-neutral-500)">No material dispatch records yet.</div>`
              : `<table class="table" style="min-width:${isAdmin ? '860' : '680'}px">
                  <thead><tr><th>Date</th><th>Reference</th><th>Items</th><th>Status</th><th>File</th>${isAdmin ? '<th>Payment</th>' : ''}<th></th></tr></thead>
                  <tbody>${state.dispatches.map((d) => renderDispatchRow(d, state, isAdmin)).join('')}</tbody>
                </table>`
      }
    </div>
  `;
}

function renderForm(state) {
  const { form } = state;
  return `
    <div class="card elev-sm" style="margin-bottom:16px" data-role="dispatch-form">
      <h3 class="card-title" style="font-size:16px">New Dispatch</h3>

      <div class="field" style="margin-top:10px">
        <label for="md-challan-file">Upload Delivery Challan (optional)</label>
        <input id="md-challan-file" type="file" accept="application/pdf,image/*" data-action="challan-file" class="input" style="padding:6px" ${form.challanOcrBusy ? 'disabled' : ''} />
        <p style="font-size:12px;color:var(--color-neutral-500);margin-top:6px">Item and quantity are read automatically where possible — review and correct every row before saving.</p>
        ${form.challanFileName ? `<p style="font-size:12px;color:var(--color-neutral-500);margin-top:6px">Selected: ${escapeHtml(form.challanFileName)}</p>` : ''}
        ${form.challanOcrBusy ? `<p data-role="challan-ocr-busy" style="font-size:12px;color:var(--color-neutral-500);margin-top:4px">Scanning document for item/quantity lines… this can take up to a minute on a scanned/photographed file.</p>` : ''}
        ${!form.challanOcrBusy && form.challanParseNote ? `<p data-role="challan-parse-note" style="font-size:12px;color:var(--color-neutral-500);margin-top:4px">${escapeHtml(form.challanParseNote)}</p>` : ''}
      </div>

      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;margin-top:10px">
        <div class="field"><label for="md-date">Dispatch Date</label>
          <input class="input" id="md-date" type="date" data-action="form-dispatch-date" value="${escapeHtml(form.dispatchDate)}" />
        </div>
        <div class="field"><label for="md-reference">Reference (optional)</label>
          <input class="input" id="md-reference" data-action="form-reference" value="${escapeHtml(form.reference)}" placeholder="Customer, site, project…" />
        </div>
        <div class="field"><label for="md-notes">Notes (optional)</label>
          <input class="input" id="md-notes" data-action="form-notes" value="${escapeHtml(form.notes)}" />
        </div>
      </div>

      <div style="margin-top:14px">
        <div style="display:flex;align-items:center;justify-content:space-between">
          <label style="font-size:13px;font-weight:500">Items Dispatched</label>
          <button type="button" class="btn btn-secondary" data-action="add-row" style="padding:5px 12px;font-size:12px">+ Add Row</button>
        </div>
        <table class="table" style="min-width:420px;margin-top:8px">
          <thead><tr><th>Item</th><th>Quantity</th><th></th></tr></thead>
          <tbody>${form.lineItems.map((row, i) => renderLineItemRow(row, i, state.items)).join('')}</tbody>
        </table>
      </div>

      ${state.formError ? `<p data-role="form-error" style="font-size:12px;color:var(--color-accent-2-200);margin-top:10px">${escapeHtml(state.formError)}</p>` : ''}
      <div style="margin-top:14px;display:flex;gap:8px">
        <button type="button" class="btn btn-primary" data-action="save-dispatch" ${state.saving || form.challanOcrBusy ? 'disabled' : ''}>${state.saving ? 'Saving…' : 'Save Dispatch'}</button>
        <button type="button" class="btn btn-ghost" data-action="cancel-form">Cancel</button>
      </div>
    </div>
  `;
}

function renderLineItemRow(row, index, items) {
  const { valid, errors } = validateMaterialDispatchLineItemLocal(row);
  return `
    <tr data-dispatch-line-row="${index}">
      <td>
        <select class="input" data-action="line-item" data-index="${index}" style="min-width:160px;${errors.itemId ? 'border-color:var(--color-accent-2)' : ''}">
          <option value="">Select item…</option>
          ${items.map((it) => `<option value="${escapeHtml(it.id)}" ${row.itemId === it.id ? 'selected' : ''}>${escapeHtml(it.name)}</option>`).join('')}
        </select>
      </td>
      <td><input class="input" data-action="line-quantity" data-index="${index}" type="text" inputmode="decimal" value="${escapeHtml(row.quantity)}" style="width:100px;${errors.quantity ? 'border-color:var(--color-accent-2)' : ''}" /></td>
      <td><button type="button" class="btn btn-ghost" data-action="remove-row" data-index="${index}" aria-label="Remove row">🗑</button></td>
    </tr>
    ${!valid ? `<tr><td colspan="3" style="padding:0 8px 8px;font-size:11px;color:var(--color-accent-2-200)">${escapeHtml(Object.values(errors)[0])}</td></tr>` : ''}
  `;
}

// Only flags a row once something's been entered into it — an untouched
// blank row (the default single starting row, or a freshly added one)
// shouldn't show an error before the user has done anything with it.
function validateMaterialDispatchLineItemLocal(row) {
  if (!row.itemId && String(row.quantity).trim() === '') return { valid: true, errors: {} };
  const errors = {};
  if (!row.itemId) errors.itemId = 'Select an item.';
  const qtyNum = Number(row.quantity);
  if (row.quantity === '' || !Number.isFinite(qtyNum) || qtyNum <= 0) errors.quantity = 'Enter a positive quantity.';
  return { valid: Object.keys(errors).length === 0, errors };
}

function renderDispatchRow(dispatch, state, isAdmin) {
  const isOpen = state.openDispatchId === dispatch.id;
  const lineItems = dispatch.line_items || [];
  const itemsSummary =
    lineItems.length === 0
      ? '—'
      : lineItems.length === 1
        ? escapeHtml(lineItems[0].item?.name || '—')
        : `${escapeHtml(lineItems[0].item?.name || '—')} +${lineItems.length - 1} more`;
  const authorized = Boolean(dispatch.authorized_at);
  const hasFile = Boolean(dispatch.challan_file_path);
  const authorizeError = state.authorizeErrorByDispatch[dispatch.id];
  const paymentError = state.paymentErrorByDispatch[dispatch.id];

  const rows = [
    `<tr data-dispatch-row="${escapeHtml(dispatch.id)}">
      <td>${escapeHtml(dispatch.dispatch_date)}</td>
      <td>${escapeHtml(dispatch.reference || '—')}</td>
      <td>${itemsSummary}</td>
      <td><span class="tag ${authorized ? 'tag-success' : 'tag-neutral'}" data-role="dispatch-status">${authorized ? 'Authorized' : 'Pending Authorization'}</span></td>
      <td>${hasFile ? `<button type="button" class="btn btn-ghost" data-action="view-dispatch-file" data-path="${escapeHtml(dispatch.challan_file_path)}" style="padding:4px 10px;font-size:12px">View</button>` : '—'}</td>
      ${
        isAdmin
          ? `<td data-role="payment-cell">
              ${
                dispatch.payment_received_at
                  ? `<span class="tag tag-success">Received ${escapeHtml(new Date(dispatch.payment_received_at).toLocaleDateString())}</span>`
                  : authorized
                    ? `<button type="button" class="btn btn-secondary" data-action="mark-payment" data-id="${escapeHtml(dispatch.id)}" style="padding:4px 10px;font-size:12px" ${state.markingPaymentId === dispatch.id ? 'disabled' : ''}>${state.markingPaymentId === dispatch.id ? 'Marking…' : 'Mark Payment Received'}</button>`
                    : '—'
              }
            </td>`
          : ''
      }
      <td style="white-space:nowrap">
        <button type="button" class="btn btn-ghost" data-action="toggle-dispatch" data-id="${escapeHtml(dispatch.id)}" style="padding:4px 10px;font-size:12px">${isOpen ? 'Hide' : 'Details'}</button>
        ${
          isAdmin && !authorized
            ? `<button type="button" class="btn btn-secondary" data-action="authorize-dispatch" data-id="${escapeHtml(dispatch.id)}" style="padding:4px 10px;font-size:12px" ${state.authorizingId === dispatch.id ? 'disabled' : ''}>${state.authorizingId === dispatch.id ? 'Authorizing…' : 'Authorize'}</button>`
            : ''
        }
      </td>
    </tr>`,
  ];

  if (isOpen) {
    rows.push(`
      <tr data-dispatch-detail-row="${escapeHtml(dispatch.id)}">
        <td colspan="${isAdmin ? 7 : 6}" style="padding:12px 14px;border-top:1px solid var(--color-divider)">
          ${dispatch.notes ? `<p style="font-size:12px;color:var(--color-neutral-500);margin:0 0 10px">${escapeHtml(dispatch.notes)}</p>` : ''}
          ${
            lineItems.length === 0
              ? `<p style="font-size:13px;color:var(--color-neutral-500)">No items recorded.</p>`
              : `<table class="table" style="min-width:320px">
                  <thead><tr><th>Item</th><th>Quantity</th></tr></thead>
                  <tbody>
                    ${lineItems
                      .map((li) => `<tr><td>${escapeHtml(li.item?.name || '—')}</td><td>${li.quantity}${li.item?.unit_of_measure ? ` ${escapeHtml(li.item.unit_of_measure)}` : ''}</td></tr>`)
                      .join('')}
                  </tbody>
                </table>`
          }
          ${authorizeError ? `<p data-role="authorize-error" data-id="${escapeHtml(dispatch.id)}" style="font-size:12px;color:var(--color-accent-2-200);margin-top:10px">${escapeHtml(authorizeError)}</p>` : ''}
          ${paymentError ? `<p data-role="payment-error" data-id="${escapeHtml(dispatch.id)}" style="font-size:12px;color:var(--color-accent-2-200);margin-top:10px">${escapeHtml(paymentError)}</p>` : ''}
        </td>
      </tr>
    `);
  }

  return rows.join('');
}

function wireEvents(container, store, user, load, canCreate, isAdmin) {
  container.querySelector('[data-action="retry"]')?.addEventListener('click', load);

  container.querySelectorAll('[data-action="toggle-dispatch"]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const state = store.getState();
      const id = btn.dataset.id;
      store.setState({ openDispatchId: state.openDispatchId === id ? null : id });
    });
  });

  container.querySelectorAll('[data-action="view-dispatch-file"]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      try {
        const url = await getDispatchChallanFileUrl(btn.dataset.path);
        if (url) window.open(url, '_blank', 'noopener');
      } catch (err) {
        store.setState({ fileActionError: err.message || 'Could not open this file.' });
      }
    });
  });

  if (isAdmin) {
    container.querySelectorAll('[data-action="authorize-dispatch"]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.id;
        const state = store.getState();
        if (!window.confirm('Authorize this dispatch? This will deduct the listed items from inventory.')) return;
        store.setState({ authorizingId: id, authorizeErrorByDispatch: { ...state.authorizeErrorByDispatch, [id]: null } });
        try {
          await authorizeMaterialDispatch(id);
          await load();
          store.setState({ authorizingId: null, openDispatchId: id });
        } catch (err) {
          store.setState({
            authorizingId: null,
            authorizeErrorByDispatch: { ...store.getState().authorizeErrorByDispatch, [id]: err.message || 'Could not authorize this dispatch.' },
          });
        }
      });
    });

    container.querySelectorAll('[data-action="mark-payment"]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.id;
        const state = store.getState();
        store.setState({ markingPaymentId: id, paymentErrorByDispatch: { ...state.paymentErrorByDispatch, [id]: null } });
        try {
          await markDispatchPaymentReceived(id);
          await load();
          store.setState({ markingPaymentId: null });
        } catch (err) {
          store.setState({
            markingPaymentId: null,
            paymentErrorByDispatch: { ...store.getState().paymentErrorByDispatch, [id]: err.message || 'Could not mark payment received.' },
          });
        }
      });
    });
  }

  if (!canCreate) return;

  container.querySelector('[data-action="new-dispatch"]')?.addEventListener('click', () => {
    store.setState({ formMode: true, form: emptyForm(), formError: null });
  });
  container.querySelector('[data-action="cancel-form"]')?.addEventListener('click', () => {
    store.setState({ formMode: false });
  });

  const dateInput = container.querySelector('[data-action="form-dispatch-date"]');
  if (dateInput) {
    // Tab out of a native date input normally moves between its own
    // day/month/year segments first (genuine browser behavior, not a
    // bug) — skipDateSegmentsOnTab makes Tab always leave the field
    // immediately, like every other field here.
    skipDateSegmentsOnTab(dateInput);
    onRealBlur(dateInput, (e) => {
      const value = e.target.value;
      afterFocusSettles(() => {
        const state = store.getState();
        store.setState({ form: { ...state.form, dispatchDate: value } });
      });
    });
  }
  container.querySelector('[data-action="form-reference"]')?.addEventListener('input', (e) => {
    const state = store.getState();
    store.setState({ form: { ...state.form, reference: e.target.value } });
  });
  container.querySelector('[data-action="form-notes"]')?.addEventListener('input', (e) => {
    const state = store.getState();
    store.setState({ form: { ...state.form, notes: e.target.value } });
  });

  container.querySelector('[data-action="add-row"]')?.addEventListener('click', () => {
    const state = store.getState();
    store.setState({ form: { ...state.form, lineItems: [...state.form.lineItems, emptyLineItem()] } });
  });
  container.querySelectorAll('[data-action="remove-row"]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const state = store.getState();
      const index = Number(btn.dataset.index);
      store.setState({ form: { ...state.form, lineItems: state.form.lineItems.filter((_, i) => i !== index) } });
    });
  });
  const updateLineItem = (index, patch) => {
    const state = store.getState();
    const lineItems = state.form.lineItems.map((row, i) => (i === index ? { ...row, ...patch } : row));
    store.setState({ form: { ...state.form, lineItems } });
  };
  container.querySelectorAll('[data-action="line-item"]').forEach((el) =>
    el.addEventListener('change', () => updateLineItem(Number(el.dataset.index), { itemId: el.value }))
  );
  container.querySelectorAll('[data-action="line-quantity"]').forEach((el) =>
    el.addEventListener('input', () => updateLineItem(Number(el.dataset.index), { quantity: el.value }))
  );

  container.querySelector('[data-action="challan-file"]')?.addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const state = store.getState();
    store.setState({ form: { ...state.form, challanFile: file, challanFileName: file.name, challanParseNote: null } });

    let parsedRows = [];
    let readFailed = false;

    if (file.type === 'application/pdf') {
      try {
        const text = await extractPdfText(file);
        parsedRows = parseChallanText(text);
      } catch {
        readFailed = true;
      }
    }

    // Nothing found yet (a scanned/photographed PDF with no text layer, a
    // plain image file, or a PDF read failure) — fall back to OCR before
    // giving up and asking for manual entry, same fallback chain as
    // Material Inward's own challan upload.
    if (!readFailed && parsedRows.length === 0) {
      store.setState({ form: { ...store.getState().form, challanOcrBusy: true } });
      // Dynamically imported — OCR (tesseract.js) is a sizeable dependency
      // only worth fetching once a document actually needs this fallback.
      const { ocrFile } = await import('../ocr.js');
      const ocrText = await ocrFile(file);
      // The user may have picked a different file while OCR was running.
      if (store.getState().form.challanFile !== file) return;
      store.setState({ form: { ...store.getState().form, challanOcrBusy: false } });
      if (ocrText) parsedRows = parseChallanText(ocrText);
    }

    if (readFailed) {
      store.setState({ form: { ...store.getState().form, challanParseNote: "Couldn't read this file — enter items by hand below." } });
      return;
    }
    if (parsedRows.length === 0) {
      store.setState({
        form: { ...store.getState().form, challanParseNote: "Couldn't find any recognizable item/qty lines in this document — enter items by hand below." },
      });
      return;
    }

    const currentState = store.getState();
    const { matchedLineItems, matchedCount, totalParsed } = matchChallanToItems(parsedRows, currentState.items);
    const existingRows = currentState.form.lineItems.filter((row) => row.itemId || String(row.quantity).trim() !== '');
    store.setState({
      form: {
        ...currentState.form,
        lineItems: matchedLineItems.length > 0 ? [...existingRows, ...matchedLineItems] : currentState.form.lineItems,
        challanParseNote:
          matchedCount === 0
            ? "Couldn't match any lines in this document to an item in the Item Master — enter items by hand below."
            : `Matched ${matchedCount} of ${totalParsed} line(s) from the document — review before saving.`,
      },
    });
  });

  container.querySelector('[data-action="save-dispatch"]')?.addEventListener('click', async () => {
    const state = store.getState();
    const { valid, errors } = validateMaterialDispatchForm(state.form);
    if (!valid) {
      store.setState({ formError: Object.values(errors)[0] });
      return;
    }
    store.setState({ saving: true, formError: null });
    try {
      const dispatch = await createMaterialDispatch({
        dispatchDate: state.form.dispatchDate,
        reference: state.form.reference,
        notes: state.form.notes,
        createdBy: user.id,
        lineItems: state.form.lineItems
          .filter((row) => row.itemId && String(row.quantity).trim() !== '')
          .map((row) => ({ itemId: row.itemId, quantity: Number(row.quantity) })),
      });
      if (state.form.challanFile) {
        try {
          await uploadDispatchChallanFile(dispatch.id, state.form.challanFile);
        } catch {
          // The dispatch itself is already saved — a failed attach is a
          // secondary, correctable problem, never a reason to make the
          // whole save look like it failed.
        }
      }
      store.setState({ saving: false, formMode: false });
      await load();
    } catch (err) {
      store.setState({ saving: false, formError: err.message || 'Could not save this dispatch.' });
    }
  });
}
