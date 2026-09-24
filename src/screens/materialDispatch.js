// Material Dispatch (Phase 11): dispatch material out — scan a delivery
// challan (or enter by hand) to pick what's being dispatched, same
// upload-and-scan pattern as Material Inward/PO Upload/Invoices, including
// the OCR fallback for a scanned/photographed challan. Store/admin can
// create a dispatch record by default — now the dynamic
// manage_store_operations right (Roles & Rights addendum — see
// rolePermissions.js/schema.sql's is_store_or_admin) rather than a
// hardcoded role check — but it never moves stock by itself — only an
// admin authorizing it does (authorize_material_dispatch(), atomically
// deducting every line item — see supabase/schema.sql), matching the
// direct request that inventory deduction wait for admin sign-off.
//
// Phase 13 addendum (direct request): every dispatch is now also a real,
// billable Delivery Challan — a DC number, the party (customer) it went
// to, and a per-line rate so an amount can be computed. The client's own
// PO number this dispatch fulfills is admin-only to enter (this screen
// only ever shows that field to an admin; schema.sql's insert policy
// enforces the same rule server-side, so it's not just a UI nicety), and
// can also be added/edited later by admin from the Delivery Challans
// screen if a store user created the record. That new screen (admin-only)
// is also where the DC-level Paid/Pending payment status now lives —
// this screen stays focused on creating and authorizing dispatches.
//
// Second Phase 13 addendum (direct request): a GST % per dispatch
// (defaulting to 18, the most common slab, but editable) so a Final
// Amount — Total Amount with GST added — can be shown alongside every
// dispatch, here and on Delivery Challans. See dispatchTotalAmount/
// dispatchFinalAmount in ../materialDispatch.js for the shared math.
//
// Third Phase 13 addendum (direct request): double-clicking an
// unauthorized dispatch's row opens this same form in edit mode instead
// of a fresh "New Dispatch", pre-filled from that dispatch — the Upload
// Delivery Challan card is hidden while editing (nothing to re-parse
// onto an existing entry), the heading/Save button read "Edit
// Dispatch"/"Save Changes", and Save calls updateMaterialDispatch
// instead of createMaterialDispatch. Blocked once a dispatch is
// authorized (no cursor-pointer affordance, dblclick does nothing) —
// see update_material_dispatch() in supabase/schema.sql for why.
import { getCurrentProfile } from '../auth.js';
import { renderShell } from '../layout.js';
import { escapeHtml } from '../components.js';
import { createStore } from '../state.js';
import { canViewModule } from '../navPermissions.js';
import {
  fetchMaterialDispatches,
  createMaterialDispatch,
  updateMaterialDispatch,
  uploadDispatchChallanFile,
  getDispatchChallanFileUrl,
  authorizeMaterialDispatch,
  dispatchFinalAmount,
} from '../materialDispatch.js';
import { fetchItems } from '../items.js';
import { fetchCurrentRates } from '../itemPricing.js';
import { validateMaterialDispatchForm } from '../validation.js';
import { repaintPreservingFocus, afterFocusSettles, skipDateSegmentsOnTab, onRealBlur } from '../domFocus.js';
import { extractPdfText, parseChallanText } from '../pdfParser.js';
import { fetchRolePermissionsGuarded, hasPermission } from '../rolePermissions.js';

const todayISO = () => new Date().toISOString().slice(0, 10);
const DEFAULT_GST_PERCENT = '18';

function emptyLineItem() {
  return { itemId: '', quantity: '', rate: '' };
}

function emptyForm() {
  return {
    dispatchDate: todayISO(),
    dcNumber: '',
    party: '',
    ourInvoiceNumber: '',
    clientPoNumber: '',
    gstPercent: DEFAULT_GST_PERCENT,
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
    currentRates: [],
    loading: true,
    error: false,
    formMode: false,
    form: emptyForm(),
    // Set while the open form is editing an existing (unauthorized)
    // dispatch rather than creating a new one — see the double-click
    // wiring below and updateMaterialDispatch in ../materialDispatch.js.
    editingDispatchId: null,
    formError: null,
    saving: false,
    openDispatchId: null,
    authorizingId: null,
    authorizeErrorByDispatch: {},
    fileActionError: null,
    rolePermissions: [],
  };
}

/**
 * Maps an existing dispatch (with its line items) onto the same form
 * shape emptyForm() produces, for edit mode.
 * @param {any} dispatch
 */
function formFromDispatch(dispatch) {
  return {
    dispatchDate: dispatch.dispatch_date,
    dcNumber: dispatch.dc_number || '',
    party: dispatch.reference || '',
    ourInvoiceNumber: dispatch.our_invoice_number || '',
    clientPoNumber: dispatch.client_po_number || '',
    gstPercent: dispatch.gst_percent === null || dispatch.gst_percent === undefined ? '' : String(dispatch.gst_percent),
    notes: dispatch.notes || '',
    lineItems: (dispatch.line_items || []).map((li) => ({
      itemId: li.item_id,
      quantity: String(li.quantity),
      rate: li.rate === null || li.rate === undefined ? '' : String(li.rate),
    })),
    challanFile: null,
    challanFileName: '',
    challanParseNote: null,
    challanOcrBusy: false,
  };
}

/**
 * Matches parsed challan lines (item name + quantity) to the Item Master
 * by (trimmed, case-insensitive) name — same matching discipline as
 * Material Inward's matchChallanToLineItems, just against the whole Item
 * Master here instead of one PO's line items, since a dispatch isn't
 * fulfilling any particular PO. A matched row's rate is prefilled from
 * the item's current rate where one exists (same "prefill, never
 * force" spirit as the item-select handler below) — still just a
 * starting point the user must review, like every other OCR-derived
 * field on this form.
 * @param {{ itemName: string, quantity: number }[]} parsedRows
 * @param {{ id: string, name: string }[]} items
 * @param {{ item_id: string, rate: number }[]} currentRates
 */
function matchChallanToItems(parsedRows, items, currentRates) {
  const matchedLineItems = [];
  let matchedCount = 0;
  for (const row of parsedRows) {
    const target = items.find((it) => it.name.trim().toLowerCase() === row.itemName.trim().toLowerCase());
    if (target) {
      const currentRate = currentRates.find((r) => r.item_id === target.id);
      matchedLineItems.push({ itemId: target.id, quantity: String(row.quantity), rate: currentRate ? String(currentRate.rate) : '' });
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
  // Fetched before the guard (Roles & Rights addendum) — a role granted
  // the matching right sees and can use this screen even though it's not
  // in navPermissions.js's own fixed list, so the guard has to consult
  // the same rows the sidebar link's own visibility does (canViewModule).
  // load() below fetches its own copy for the "+ New Dispatch" button's
  // own gating — a second small fetch, not reused here, to keep this
  // early check independent of that state-managed flow.
  const rolePermissionsForGuard = await fetchRolePermissionsGuarded();
  if (!canViewModule('/material-dispatch', user.role, rolePermissionsForGuard)) {
    window.location.hash = '#/dashboard';
    return;
  }
  const isAdmin = user.role === 'admin';

  const content = await renderShell(container, { activeRoute: '/material-dispatch', user, rolePermissions: rolePermissionsForGuard });
  content.setAttribute('data-screen', 'material-dispatch');
  const store = createStore(initialState());

  async function load() {
    store.setState({ loading: true, error: false });
    try {
      const [dispatches, items, currentRates, rolePermissions] = await Promise.all([
        fetchMaterialDispatches(),
        fetchItems(),
        fetchCurrentRates(),
        fetchRolePermissionsGuarded(),
      ]);
      store.setState({ dispatches, items, currentRates, rolePermissions, loading: false, error: false });
    } catch {
      store.setState({ loading: false, error: true });
    }
  }

  function paint() {
    const canCreate = hasPermission(store.getState().rolePermissions, user.role, 'manage_store_operations');
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
      <div>
        <h1 style="margin:0">Material Dispatch</h1>
        ${canCreate && !state.formMode ? `<p style="margin:4px 0 0;font-size:12px;color:var(--color-neutral-500)">Double-click a not-yet-authorized row to edit it.</p>` : ''}
      </div>
      ${canCreate && !state.formMode ? `<button type="button" class="btn btn-secondary" data-action="new-dispatch">+ New Dispatch</button>` : ''}
    </div>

    ${state.fileActionError ? `<p data-role="file-action-error" style="font-size:13px;color:var(--color-accent-2-200);background:var(--color-accent-2-900);border:1px solid var(--color-accent-2-700);border-radius:var(--radius-md);padding:8px 12px;margin-bottom:14px">${escapeHtml(state.fileActionError)}</p>` : ''}

    ${state.formMode ? renderForm(state, isAdmin, Boolean(state.editingDispatchId)) : ''}

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
              : `<table class="table" style="min-width:920px">
                  <thead><tr><th>Date</th><th>DC No.</th><th>Party</th><th>Items</th><th>Final Amount</th><th>Status</th><th>File</th><th></th></tr></thead>
                  <tbody>${state.dispatches.map((d) => renderDispatchRow(d, state, isAdmin, canCreate)).join('')}</tbody>
                </table>`
      }
    </div>
  `;
}

function renderForm(state, isAdmin, editing) {
  const { form } = state;
  return `
    <div class="card elev-sm" style="margin-bottom:16px" data-role="dispatch-form">
      <h3 class="card-title" style="font-size:16px">${editing ? 'Edit Dispatch' : 'New Dispatch'}</h3>

      ${
        editing
          ? ''
          : `<div class="field" style="margin-top:10px">
        <label for="md-challan-file">Upload Delivery Challan (optional)</label>
        <input id="md-challan-file" type="file" accept="application/pdf,image/*" data-action="challan-file" class="input" style="padding:6px" ${form.challanOcrBusy ? 'disabled' : ''} />
        <p style="font-size:12px;color:var(--color-neutral-500);margin-top:6px">Item and quantity are read automatically where possible — review and correct every row before saving.</p>
        ${form.challanFileName ? `<p style="font-size:12px;color:var(--color-neutral-500);margin-top:6px">Selected: ${escapeHtml(form.challanFileName)}</p>` : ''}
        ${form.challanOcrBusy ? `<p data-role="challan-ocr-busy" style="font-size:12px;color:var(--color-neutral-500);margin-top:4px">Scanning document for item/quantity lines… this can take up to a minute on a scanned/photographed file.</p>` : ''}
        ${!form.challanOcrBusy && form.challanParseNote ? `<p data-role="challan-parse-note" style="font-size:12px;color:var(--color-neutral-500);margin-top:4px">${escapeHtml(form.challanParseNote)}</p>` : ''}
      </div>`
      }

      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;margin-top:10px">
        <div class="field"><label for="md-date">Dispatch Date</label>
          <input class="input" id="md-date" type="date" data-action="form-dispatch-date" value="${escapeHtml(form.dispatchDate)}" />
        </div>
        <div class="field"><label for="md-dc-number">DC No.</label>
          <input class="input" id="md-dc-number" data-action="form-dc-number" value="${escapeHtml(form.dcNumber)}" placeholder="Delivery challan number" />
        </div>
        <div class="field"><label for="md-party">Party</label>
          <input class="input" id="md-party" data-action="form-party" value="${escapeHtml(form.party)}" placeholder="Customer this is dispatched to" />
        </div>
        <div class="field"><label for="md-invoice-number">Our Invoice # (optional)</label>
          <input class="input" id="md-invoice-number" data-action="form-invoice-number" value="${escapeHtml(form.ourInvoiceNumber)}" />
        </div>
        <div class="field"><label for="md-gst-percent">GST %</label>
          <input class="input" id="md-gst-percent" data-action="form-gst-percent" type="text" inputmode="decimal" value="${escapeHtml(form.gstPercent)}" />
        </div>
        ${
          isAdmin
            ? `<div class="field"><label for="md-client-po">PO No. (Client, optional)</label>
                <input class="input" id="md-client-po" data-action="form-client-po" value="${escapeHtml(form.clientPoNumber)}" placeholder="Client's PO this dispatch fulfills" />
              </div>`
            : ''
        }
        <div class="field"><label for="md-notes">Notes (optional)</label>
          <input class="input" id="md-notes" data-action="form-notes" value="${escapeHtml(form.notes)}" />
        </div>
      </div>

      <div style="margin-top:14px">
        <div style="display:flex;align-items:center;justify-content:space-between">
          <label style="font-size:13px;font-weight:500">Items Dispatched</label>
          <button type="button" class="btn btn-secondary" data-action="add-row" style="padding:5px 12px;font-size:12px">+ Add Row</button>
        </div>
        <table class="table" style="min-width:560px;margin-top:8px">
          <thead><tr><th>Item</th><th>Quantity</th><th>Rate</th><th>Amount</th><th></th></tr></thead>
          <tbody>${form.lineItems.map((row, i) => renderLineItemRow(row, i, state.items)).join('')}</tbody>
        </table>
      </div>

      ${state.formError ? `<p data-role="form-error" style="font-size:12px;color:var(--color-accent-2-200);margin-top:10px">${escapeHtml(state.formError)}</p>` : ''}
      <div style="margin-top:14px;display:flex;gap:8px">
        <button type="button" class="btn btn-primary" data-action="save-dispatch" ${state.saving || form.challanOcrBusy ? 'disabled' : ''}>${state.saving ? 'Saving…' : editing ? 'Save Changes' : 'Save Dispatch'}</button>
        <button type="button" class="btn btn-ghost" data-action="cancel-form">Cancel</button>
      </div>
    </div>
  `;
}

function renderLineItemRow(row, index, items) {
  const { valid, errors } = validateMaterialDispatchLineItemLocal(row);
  const qtyNum = Number(row.quantity);
  const rateNum = Number(row.rate);
  const amount = row.quantity !== '' && row.rate !== '' && Number.isFinite(qtyNum) && Number.isFinite(rateNum) ? (qtyNum * rateNum).toFixed(2) : '—';
  return `
    <tr data-dispatch-line-row="${index}">
      <td>
        <select class="input" data-action="line-item" data-index="${index}" style="min-width:160px;${errors.itemId ? 'border-color:var(--color-accent-2)' : ''}">
          <option value="">Select item…</option>
          ${items.map((it) => `<option value="${escapeHtml(it.id)}" ${row.itemId === it.id ? 'selected' : ''}>${escapeHtml(it.name)}</option>`).join('')}
        </select>
      </td>
      <td><input class="input" data-action="line-quantity" data-index="${index}" type="text" inputmode="decimal" value="${escapeHtml(row.quantity)}" style="width:100px;${errors.quantity ? 'border-color:var(--color-accent-2)' : ''}" /></td>
      <td><input class="input" data-action="line-rate" data-index="${index}" type="text" inputmode="decimal" value="${escapeHtml(row.rate)}" style="width:100px;${errors.rate ? 'border-color:var(--color-accent-2)' : ''}" /></td>
      <td data-role="line-amount">${amount}</td>
      <td><button type="button" class="btn btn-ghost" data-action="remove-row" data-index="${index}" aria-label="Remove row">🗑</button></td>
    </tr>
    ${!valid ? `<tr><td colspan="5" style="padding:0 8px 8px;font-size:11px;color:var(--color-accent-2-200)">${escapeHtml(Object.values(errors)[0])}</td></tr>` : ''}
  `;
}

// Only flags a row once something's been entered into it — an untouched
// blank row (the default single starting row, or a freshly added one)
// shouldn't show an error before the user has done anything with it.
function validateMaterialDispatchLineItemLocal(row) {
  if (!row.itemId && String(row.quantity).trim() === '' && String(row.rate).trim() === '') return { valid: true, errors: {} };
  const errors = {};
  if (!row.itemId) errors.itemId = 'Select an item.';
  const qtyNum = Number(row.quantity);
  if (row.quantity === '' || !Number.isFinite(qtyNum) || qtyNum <= 0) errors.quantity = 'Enter a positive quantity.';
  const rateNum = Number(row.rate);
  if (row.rate === '' || !Number.isFinite(rateNum) || rateNum < 0) errors.rate = 'Enter a rate (0 or more).';
  return { valid: Object.keys(errors).length === 0, errors };
}

function renderDispatchRow(dispatch, state, isAdmin, canCreate) {
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
  const dblClickable = canCreate && !authorized;

  const rows = [
    `<tr data-dispatch-row="${escapeHtml(dispatch.id)}" style="${dblClickable ? 'cursor:pointer' : ''}" ${dblClickable ? 'title="Double-click to edit"' : ''}>
      <td>${escapeHtml(dispatch.dispatch_date)}</td>
      <td>${escapeHtml(dispatch.dc_number || '—')}</td>
      <td>${escapeHtml(dispatch.reference || '—')}</td>
      <td>${itemsSummary}</td>
      <td data-role="dispatch-final-amount">₹${dispatchFinalAmount(dispatch).toFixed(2)}</td>
      <td><span class="tag ${authorized ? 'tag-success' : 'tag-neutral'}" data-role="dispatch-status">${authorized ? 'Authorized' : 'Pending Authorization'}</span></td>
      <td>${hasFile ? `<button type="button" class="btn btn-ghost" data-action="view-dispatch-file" data-path="${escapeHtml(dispatch.challan_file_path)}" style="padding:4px 10px;font-size:12px">View</button>` : '—'}</td>
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
        <td colspan="8" style="padding:12px 14px;border-top:1px solid var(--color-divider)">
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
  }

  if (!canCreate) return;

  container.querySelector('[data-action="new-dispatch"]')?.addEventListener('click', () => {
    store.setState({ formMode: true, editingDispatchId: null, form: emptyForm(), formError: null });
  });
  container.querySelector('[data-action="cancel-form"]')?.addEventListener('click', () => {
    store.setState({ formMode: false, editingDispatchId: null });
  });

  container.querySelectorAll('[data-dispatch-row]').forEach((row) => {
    row.addEventListener('dblclick', () => {
      const state = store.getState();
      const dispatch = state.dispatches.find((d) => d.id === row.dataset.dispatchRow);
      if (!dispatch || dispatch.authorized_at) return; // already authorized — nothing to edit
      store.setState({ formMode: true, editingDispatchId: dispatch.id, form: formFromDispatch(dispatch), formError: null });
    });
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
  container.querySelector('[data-action="form-dc-number"]')?.addEventListener('input', (e) => {
    const state = store.getState();
    store.setState({ form: { ...state.form, dcNumber: e.target.value } });
  });
  container.querySelector('[data-action="form-party"]')?.addEventListener('input', (e) => {
    const state = store.getState();
    store.setState({ form: { ...state.form, party: e.target.value } });
  });
  container.querySelector('[data-action="form-invoice-number"]')?.addEventListener('input', (e) => {
    const state = store.getState();
    store.setState({ form: { ...state.form, ourInvoiceNumber: e.target.value } });
  });
  container.querySelector('[data-action="form-client-po"]')?.addEventListener('input', (e) => {
    const state = store.getState();
    store.setState({ form: { ...state.form, clientPoNumber: e.target.value } });
  });
  container.querySelector('[data-action="form-gst-percent"]')?.addEventListener('input', (e) => {
    const state = store.getState();
    store.setState({ form: { ...state.form, gstPercent: e.target.value } });
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
    el.addEventListener('change', () => {
      const state = store.getState();
      const row = state.form.lineItems[Number(el.dataset.index)];
      // Only prefills an untouched rate field — never overwrites a rate
      // the user already typed, e.g. after changing their mind about
      // which item a row is for.
      const currentRate = row && row.rate === '' ? state.currentRates.find((r) => r.item_id === el.value) : null;
      updateLineItem(Number(el.dataset.index), currentRate ? { itemId: el.value, rate: String(currentRate.rate) } : { itemId: el.value });
    })
  );
  container.querySelectorAll('[data-action="line-quantity"]').forEach((el) =>
    el.addEventListener('input', () => updateLineItem(Number(el.dataset.index), { quantity: el.value }))
  );
  container.querySelectorAll('[data-action="line-rate"]').forEach((el) =>
    el.addEventListener('input', () => updateLineItem(Number(el.dataset.index), { rate: el.value }))
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
    const { matchedLineItems, matchedCount, totalParsed } = matchChallanToItems(parsedRows, currentState.items, currentState.currentRates);
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
    const lineItems = state.form.lineItems
      .filter((row) => row.itemId && String(row.quantity).trim() !== '' && String(row.rate).trim() !== '')
      .map((row) => ({ itemId: row.itemId, quantity: Number(row.quantity), rate: Number(row.rate) }));
    try {
      if (state.editingDispatchId) {
        await updateMaterialDispatch(state.editingDispatchId, {
          dispatchDate: state.form.dispatchDate,
          dcNumber: state.form.dcNumber,
          party: state.form.party,
          ourInvoiceNumber: state.form.ourInvoiceNumber,
          clientPoNumber: isAdmin ? state.form.clientPoNumber : '',
          gstPercent: state.form.gstPercent,
          notes: state.form.notes,
          lineItems,
        });
        store.setState({ saving: false, formMode: false, editingDispatchId: null });
        await load();
        return;
      }

      const dispatch = await createMaterialDispatch({
        dispatchDate: state.form.dispatchDate,
        dcNumber: state.form.dcNumber,
        party: state.form.party,
        ourInvoiceNumber: state.form.ourInvoiceNumber,
        // clientPoNumber is simply never in state.form for a non-admin —
        // the field itself is never rendered for them (see renderForm) —
        // so this is a no-op for anyone but admin, matching what the
        // insert policy would enforce server-side anyway.
        clientPoNumber: isAdmin ? state.form.clientPoNumber : '',
        gstPercent: state.form.gstPercent,
        notes: state.form.notes,
        createdBy: user.id,
        lineItems,
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
