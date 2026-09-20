// Delivery Challans (Phase 13, direct request): the admin-only financial
// view of every Material Dispatch record, reframed as a Delivery Challan
// register — DC No., date, Party, the client's PO number, "our" invoice
// number, total amount, and payment status, with a click-through to each
// challan's own item/quantity/rate/amount breakdown. This is a read-plus-
// billing-edit view over the same material_dispatch/material_dispatch_
// line_items data Material Dispatch itself creates and authorizes — see
// materialDispatch.js for the create/authorize flow. Admin-only, with no
// MODULE_PERMISSIONS reveal (see navPermissions.js) — same convention as
// Users & Roles/Roles & Rights/Action Log.
import { getCurrentProfile } from '../auth.js';
import { renderShell } from '../layout.js';
import { escapeHtml } from '../components.js';
import { createStore } from '../state.js';
import { canViewModule } from '../navPermissions.js';
import { fetchMaterialDispatches, updateDispatchBilling, markDispatchPaymentReceived } from '../materialDispatch.js';
import { fetchRolePermissionsGuarded } from '../rolePermissions.js';
import { repaintPreservingFocus, afterFocusSettles, skipDateSegmentsOnTab, onRealBlur } from '../domFocus.js';

const todayISO = () => new Date().toISOString().slice(0, 10);

/** Returns a shallow copy of `obj` with `key` removed. */
function omitKey(obj, key) {
  const copy = { ...obj };
  delete copy[key];
  return copy;
}

function dispatchTotal(dispatch) {
  return (dispatch.line_items || []).reduce((sum, li) => sum + Number(li.quantity) * Number(li.rate || 0), 0);
}

function initialState() {
  return {
    dispatches: [],
    loading: true,
    error: false,
    openDispatchId: null,
    // Keyed by dispatch id — only ever holds an in-progress, unsaved edit;
    // committing (or cancelling) removes the key rather than leaving a
    // stale draft around once its row is no longer being edited.
    billingEditByDispatch: {},
    billingErrorByDispatch: {},
    // Keyed by dispatch id — the in-progress "mark Paid" date, from the
    // moment the status select is switched to Paid until Save (or
    // switching back to Pending) resolves it. No revert-after-Paid path:
    // once a payment is actually recorded there's no "un-pay" RPC, same
    // as this table's other admin actions being one-way (authorize).
    pendingPaymentByDispatch: {},
    paymentErrorByDispatch: {},
  };
}

export async function render(container) {
  const user = await getCurrentProfile();
  if (!user) {
    window.location.hash = '#/login';
    return;
  }
  const rolePermissions = await fetchRolePermissionsGuarded();
  if (!canViewModule('/delivery-challans', user.role, rolePermissions)) {
    window.location.hash = '#/dashboard';
    return;
  }

  const content = await renderShell(container, { activeRoute: '/delivery-challans', user, rolePermissions });
  content.setAttribute('data-screen', 'delivery-challans');
  const store = createStore(initialState());

  async function load() {
    store.setState({ loading: true, error: false });
    try {
      const dispatches = await fetchMaterialDispatches();
      store.setState({ dispatches, loading: false, error: false });
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
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;flex-wrap:wrap;gap:12px">
      <h1 style="margin:0">Delivery Challans</h1>
    </div>

    <div class="card elev-sm" style="padding:0;overflow-x:auto">
      ${
        state.loading
          ? `<div style="padding:20px;font-size:13px;color:var(--color-neutral-500)">Loading…</div>`
          : state.error
            ? `<div style="padding:20px;text-align:center">
                <p style="font-size:13px;color:var(--color-accent-2-200);margin:0 0 10px">Couldn't load delivery challans.</p>
                <button type="button" class="btn btn-secondary" data-action="retry">Retry</button>
              </div>`
            : state.dispatches.length === 0
              ? `<div style="padding:20px;font-size:13px;color:var(--color-neutral-500)">No delivery challans recorded yet.</div>`
              : `<table class="table" style="min-width:920px">
                  <thead><tr><th>DC No.</th><th>Date</th><th>Party</th><th>PO No.</th><th>Our Invoice #</th><th>Total Amount</th><th>Status</th><th></th></tr></thead>
                  <tbody>${state.dispatches.map((d) => renderRow(d, state)).join('')}</tbody>
                </table>`
      }
    </div>
  `;
}

function renderRow(dispatch, state) {
  const isOpen = state.openDispatchId === dispatch.id;
  const authorized = Boolean(dispatch.authorized_at);
  const paid = Boolean(dispatch.payment_received_at);
  const total = dispatchTotal(dispatch);
  const billingEdit = state.billingEditByDispatch[dispatch.id];
  const billingError = state.billingErrorByDispatch[dispatch.id];
  const pendingPayment = state.pendingPaymentByDispatch[dispatch.id];
  const paymentError = state.paymentErrorByDispatch[dispatch.id];

  const rows = [
    `<tr data-challan-row="${escapeHtml(dispatch.id)}">
      <td>${escapeHtml(dispatch.dc_number || '—')}</td>
      <td>${escapeHtml(dispatch.dispatch_date)}</td>
      <td>${escapeHtml(dispatch.reference || '—')}</td>
      <td>${escapeHtml(dispatch.client_po_number || '—')}</td>
      <td>${escapeHtml(dispatch.our_invoice_number || '—')}</td>
      <td>₹${total.toFixed(2)}</td>
      <td data-role="status-cell">
        ${
          !authorized
            ? `<span class="tag tag-neutral">Pending Authorization</span>`
            : paid
              ? `<span class="tag tag-success">Paid${dispatch.payment_date ? ` (${escapeHtml(dispatch.payment_date)})` : ''}</span>`
              : `<select class="input" data-action="status-select" data-id="${escapeHtml(dispatch.id)}" style="width:auto">
                  <option value="pending" ${!pendingPayment ? 'selected' : ''}>Pending</option>
                  <option value="paid" ${pendingPayment ? 'selected' : ''}>Paid</option>
                </select>
                ${
                  pendingPayment
                    ? `<span style="display:inline-flex;align-items:center;gap:6px;margin-left:8px">
                        <input class="input" type="date" data-action="payment-date" data-id="${escapeHtml(dispatch.id)}" value="${escapeHtml(pendingPayment.date)}" style="width:auto" />
                        <button type="button" class="btn btn-secondary" data-action="save-payment" data-id="${escapeHtml(dispatch.id)}" style="padding:4px 10px;font-size:12px" ${pendingPayment.saving ? 'disabled' : ''}>${pendingPayment.saving ? 'Saving…' : 'Save'}</button>
                      </span>`
                    : ''
                }
                ${paymentError ? `<p data-role="payment-error" data-id="${escapeHtml(dispatch.id)}" style="font-size:11px;color:var(--color-accent-2-200);margin:4px 0 0">${escapeHtml(paymentError)}</p>` : ''}`
        }
      </td>
      <td style="white-space:nowrap">
        <button type="button" class="btn btn-ghost" data-action="toggle-challan" data-id="${escapeHtml(dispatch.id)}" style="padding:4px 10px;font-size:12px">${isOpen ? 'Hide' : 'Details'}</button>
      </td>
    </tr>`,
  ];

  if (isOpen) {
    const lineItems = dispatch.line_items || [];
    rows.push(`
      <tr data-challan-detail-row="${escapeHtml(dispatch.id)}">
        <td colspan="8" style="padding:12px 14px;border-top:1px solid var(--color-divider)">
          ${
            lineItems.length === 0
              ? `<p style="font-size:13px;color:var(--color-neutral-500)">No items recorded.</p>`
              : `<table class="table" style="min-width:420px">
                  <thead><tr><th>Item</th><th>Quantity</th><th>Rate</th><th>Amount</th></tr></thead>
                  <tbody>
                    ${lineItems
                      .map((li) => {
                        const rate = Number(li.rate || 0);
                        return `<tr>
                          <td>${escapeHtml(li.item?.name || '—')}</td>
                          <td>${li.quantity}${li.item?.unit_of_measure ? ` ${escapeHtml(li.item.unit_of_measure)}` : ''}</td>
                          <td>₹${rate.toFixed(2)}</td>
                          <td>₹${(Number(li.quantity) * rate).toFixed(2)}</td>
                        </tr>`;
                      })
                      .join('')}
                  </tbody>
                  <tfoot>
                    <tr style="font-weight:600"><td colspan="3" style="text-align:right">Total</td><td>₹${total.toFixed(2)}</td></tr>
                  </tfoot>
                </table>`
          }

          <div style="margin-top:14px">
            ${
              billingEdit
                ? `<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:10px;max-width:480px">
                    <div class="field"><label for="dc-po-${escapeHtml(dispatch.id)}">PO No. (Client)</label>
                      <input class="input" id="dc-po-${escapeHtml(dispatch.id)}" data-action="billing-po" data-id="${escapeHtml(dispatch.id)}" value="${escapeHtml(billingEdit.clientPoNumber)}" />
                    </div>
                    <div class="field"><label for="dc-inv-${escapeHtml(dispatch.id)}">Our Invoice #</label>
                      <input class="input" id="dc-inv-${escapeHtml(dispatch.id)}" data-action="billing-invoice" data-id="${escapeHtml(dispatch.id)}" value="${escapeHtml(billingEdit.ourInvoiceNumber)}" />
                    </div>
                  </div>
                  ${billingError ? `<p data-role="billing-error" data-id="${escapeHtml(dispatch.id)}" style="font-size:12px;color:var(--color-accent-2-200);margin-top:8px">${escapeHtml(billingError)}</p>` : ''}
                  <div style="margin-top:10px;display:flex;gap:8px">
                    <button type="button" class="btn btn-primary" data-action="save-billing" data-id="${escapeHtml(dispatch.id)}" style="padding:5px 12px;font-size:12px" ${billingEdit.saving ? 'disabled' : ''}>${billingEdit.saving ? 'Saving…' : 'Save'}</button>
                    <button type="button" class="btn btn-ghost" data-action="cancel-billing" data-id="${escapeHtml(dispatch.id)}" style="padding:5px 12px;font-size:12px">Cancel</button>
                  </div>`
                : `<button type="button" class="btn btn-secondary" data-action="edit-billing" data-id="${escapeHtml(dispatch.id)}" style="padding:5px 12px;font-size:12px">Edit PO / Invoice #</button>`
            }
          </div>
        </td>
      </tr>
    `);
  }

  return rows.join('');
}

function wireEvents(container, store, load) {
  container.querySelector('[data-action="retry"]')?.addEventListener('click', load);

  container.querySelectorAll('[data-action="toggle-challan"]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const state = store.getState();
      const id = btn.dataset.id;
      store.setState({ openDispatchId: state.openDispatchId === id ? null : id });
    });
  });

  container.querySelectorAll('[data-action="edit-billing"]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.id;
      const state = store.getState();
      const dispatch = state.dispatches.find((d) => d.id === id);
      store.setState({
        billingEditByDispatch: {
          ...state.billingEditByDispatch,
          [id]: { clientPoNumber: dispatch?.client_po_number || '', ourInvoiceNumber: dispatch?.our_invoice_number || '', saving: false },
        },
        billingErrorByDispatch: { ...state.billingErrorByDispatch, [id]: null },
      });
    });
  });

  container.querySelectorAll('[data-action="cancel-billing"]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.id;
      const state = store.getState();
      store.setState({ billingEditByDispatch: omitKey(state.billingEditByDispatch, id) });
    });
  });

  container.querySelectorAll('[data-action="billing-po"]').forEach((el) => {
    el.addEventListener('input', () => {
      const id = el.dataset.id;
      const state = store.getState();
      store.setState({ billingEditByDispatch: { ...state.billingEditByDispatch, [id]: { ...state.billingEditByDispatch[id], clientPoNumber: el.value } } });
    });
  });
  container.querySelectorAll('[data-action="billing-invoice"]').forEach((el) => {
    el.addEventListener('input', () => {
      const id = el.dataset.id;
      const state = store.getState();
      store.setState({ billingEditByDispatch: { ...state.billingEditByDispatch, [id]: { ...state.billingEditByDispatch[id], ourInvoiceNumber: el.value } } });
    });
  });

  container.querySelectorAll('[data-action="save-billing"]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.id;
      const state = store.getState();
      const edit = state.billingEditByDispatch[id];
      store.setState({
        billingEditByDispatch: { ...state.billingEditByDispatch, [id]: { ...edit, saving: true } },
        billingErrorByDispatch: { ...state.billingErrorByDispatch, [id]: null },
      });
      try {
        await updateDispatchBilling(id, edit);
        store.setState({ billingEditByDispatch: omitKey(store.getState().billingEditByDispatch, id) });
        await load();
        store.setState({ openDispatchId: id });
      } catch (err) {
        const current = store.getState();
        store.setState({
          billingEditByDispatch: { ...current.billingEditByDispatch, [id]: { ...current.billingEditByDispatch[id], saving: false } },
          billingErrorByDispatch: { ...current.billingErrorByDispatch, [id]: err.message || "Couldn't save these details." },
        });
      }
    });
  });

  container.querySelectorAll('[data-action="status-select"]').forEach((el) => {
    el.addEventListener('change', () => {
      const id = el.dataset.id;
      const state = store.getState();
      if (el.value === 'paid') {
        store.setState({ pendingPaymentByDispatch: { ...state.pendingPaymentByDispatch, [id]: { date: todayISO(), saving: false } } });
      } else {
        store.setState({ pendingPaymentByDispatch: omitKey(state.pendingPaymentByDispatch, id) });
      }
    });
  });

  container.querySelectorAll('[data-action="payment-date"]').forEach((el) => {
    // 'blur' rather than 'input' — a native date input's in-progress
    // segment can't survive a mid-edit repaint, same reasoning as every
    // other date field in this app (see e.g. invoices.js).
    skipDateSegmentsOnTab(el);
    onRealBlur(el, (e) => {
      const id = el.dataset.id;
      const value = e.target.value;
      afterFocusSettles(() => {
        const state = store.getState();
        const pending = state.pendingPaymentByDispatch[id];
        if (!pending) return;
        store.setState({ pendingPaymentByDispatch: { ...state.pendingPaymentByDispatch, [id]: { ...pending, date: value } } });
      });
    });
  });

  container.querySelectorAll('[data-action="save-payment"]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.id;
      const state = store.getState();
      const pending = state.pendingPaymentByDispatch[id];
      if (!pending || !pending.date) return;
      store.setState({
        pendingPaymentByDispatch: { ...state.pendingPaymentByDispatch, [id]: { ...pending, saving: true } },
        paymentErrorByDispatch: { ...state.paymentErrorByDispatch, [id]: null },
      });
      try {
        await markDispatchPaymentReceived(id, pending.date);
        store.setState({ pendingPaymentByDispatch: omitKey(store.getState().pendingPaymentByDispatch, id) });
        await load();
      } catch (err) {
        const current = store.getState();
        store.setState({
          pendingPaymentByDispatch: { ...current.pendingPaymentByDispatch, [id]: { ...current.pendingPaymentByDispatch[id], saving: false } },
          paymentErrorByDispatch: { ...current.paymentErrorByDispatch, [id]: err.message || "Couldn't mark payment received." },
        });
      }
    });
  });
}
