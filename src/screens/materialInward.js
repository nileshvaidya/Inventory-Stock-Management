// Material Inward (Phase 3): log receipts against a PO, including partial
// deliveries across multiple inward entries. Store/Admin only.
import { getCurrentProfile } from '../auth.js';
import { renderShell } from '../layout.js';
import { escapeHtml } from '../components.js';
import { createStore } from '../state.js';
import { canViewModule } from '../navPermissions.js';
import { fetchReceivableOrders, fetchLineItemStatusForPo, createInward, fetchInwardHistory } from '../materialInward.js';
import { validateInwardForm, validateInwardLineItem } from '../validation.js';

const todayISO = () => new Date().toISOString().slice(0, 10);

function initialState() {
  return {
    orders: [],
    poId: '',
    lineItemStatus: [],
    receivedQtyByLineItem: {},
    receivedDate: todayISO(),
    notes: '',
    history: [],
    loadingLineItems: false,
    saving: false,
    saveError: null,
    savedOk: false,
  };
}

export async function render(container) {
  const user = await getCurrentProfile();
  if (!user) {
    window.location.hash = '#/login';
    return;
  }
  if (!canViewModule('/material-inward', user.role)) {
    window.location.hash = '#/dashboard';
    return;
  }

  const content = renderShell(container, { activeRoute: '/material-inward', user });
  content.setAttribute('data-screen', 'material-inward');
  const store = createStore(initialState());

  async function loadOrders() {
    const orders = await fetchReceivableOrders();
    store.setState({ orders });
  }

  async function loadForPo(poId) {
    if (!poId) {
      store.setState({ lineItemStatus: [], receivedQtyByLineItem: {}, history: [], loadingLineItems: false });
      return;
    }
    store.setState({ loadingLineItems: true });
    const [lineItemStatus, history] = await Promise.all([fetchLineItemStatusForPo(poId), fetchInwardHistory(poId)]);
    store.setState({ lineItemStatus, history, receivedQtyByLineItem: {}, loadingLineItems: false });
  }

  function paint() {
    renderContent(content, store.getState());
    wireEvents(content, store, user, loadOrders, loadForPo);
  }

  store.subscribe(paint);
  paint();
  await loadOrders();
}

function renderContent(container, state) {
  const selectedOrder = state.orders.find((o) => o.id === state.poId);

  container.innerHTML = `
    <h1 style="margin-bottom:16px">Material Inward</h1>

    ${state.savedOk ? `<p style="font-size:13px;color:var(--color-accent-100);background:var(--color-accent-900);border:1px solid var(--color-accent-700);border-radius:var(--radius-md);padding:8px 12px;margin-bottom:14px">Receipt logged.</p>` : ''}
    ${state.saveError ? `<p data-role="save-error" style="font-size:13px;color:var(--color-accent-2-200);background:var(--color-accent-2-900);border:1px solid var(--color-accent-2-700);border-radius:var(--radius-md);padding:8px 12px;margin-bottom:14px">${escapeHtml(state.saveError)}</p>` : ''}

    <div class="card elev-sm" style="margin-bottom:16px">
      <h3 class="card-title" style="font-size:16px">Select a Purchase Order</h3>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px;margin-top:10px">
        <div class="field">
          <label for="mi-po">Purchase Order</label>
          <select class="input" id="mi-po" data-action="select-po">
            <option value="">Select…</option>
            ${state.orders.map((po) => `<option value="${escapeHtml(po.id)}" ${state.poId === po.id ? 'selected' : ''}>${escapeHtml(po.po_number || po.id.slice(0, 8))} — ${escapeHtml(po.project?.name || '—')}</option>`).join('')}
          </select>
          ${state.orders.length === 0 ? `<p style="font-size:12px;color:var(--color-neutral-500);margin-top:6px">No purchase orders are currently pending receipt.</p>` : ''}
        </div>
        <div class="field"><label for="mi-date">Received Date</label>
          <input class="input" id="mi-date" type="date" data-action="received-date" value="${escapeHtml(state.receivedDate)}" />
        </div>
      </div>
    </div>

    ${state.poId ? renderLineItemsCard(state, selectedOrder) : ''}
    ${state.poId ? renderHistoryCard(state) : ''}
  `;
}

function renderLineItemsCard(state, selectedOrder) {
  return `
    <div class="card elev-sm" style="margin-bottom:16px;padding:0;overflow-x:auto">
      <div style="padding:14px">
        <h3 class="card-title" style="font-size:16px;margin:0">Line Items — ${escapeHtml(selectedOrder?.po_number || '')}</h3>
      </div>
      ${
        state.loadingLineItems
          ? `<div style="padding:0 14px 14px;font-size:13px;color:var(--color-neutral-500)">Loading…</div>`
          : state.lineItemStatus.length === 0
            ? `<div style="padding:0 14px 14px;font-size:13px;color:var(--color-neutral-500)">No line items found for this PO.</div>`
            : `<table class="table" style="min-width:560px">
                <thead><tr><th>Item</th><th>Ordered</th><th>Already Received</th><th>Pending</th><th>Receiving Now</th></tr></thead>
                <tbody>${state.lineItemStatus.map((row) => renderLineItemRow(row, state)).join('')}</tbody>
              </table>`
      }
      <div class="field" style="padding:14px;border-top:1px solid var(--color-divider)">
        <label for="mi-notes">Notes (optional)</label>
        <input class="input" id="mi-notes" type="text" data-action="notes" value="${escapeHtml(state.notes)}" />
      </div>
      ${state.lineItemStatus.length > 0 ? `<div style="padding:0 14px 14px"><button type="button" class="btn btn-primary" data-action="save" ${state.saving ? 'disabled' : ''}>${state.saving ? 'Saving…' : 'Log Receipt'}</button></div>` : ''}
    </div>
  `;
}

function renderLineItemRow(row, state) {
  const enteredQty = state.receivedQtyByLineItem[row.po_line_item_id] ?? '';
  const { valid, errors } = validateInwardLineItem({ receivedQty: enteredQty, pendingQty: row.pending_qty });
  const showError = String(enteredQty).trim() !== '' && !valid;
  return `
    <tr data-inward-row="${escapeHtml(row.po_line_item_id)}">
      <td>${escapeHtml(row.item_name)}</td>
      <td>${row.ordered_qty}</td>
      <td>${row.received_qty}</td>
      <td>${row.pending_qty}</td>
      <td>
        <input class="input" data-action="received-qty" data-po-line-item-id="${escapeHtml(row.po_line_item_id)}" type="number" step="any" min="0" value="${escapeHtml(enteredQty)}" style="width:100px;${showError ? 'border-color:var(--color-accent-2)' : ''}" ${row.pending_qty <= 0 ? 'disabled' : ''} />
        ${showError ? `<div style="font-size:11px;color:var(--color-accent-2-200);margin-top:4px">${escapeHtml(errors.receivedQty)}</div>` : ''}
      </td>
    </tr>
  `;
}

function renderHistoryCard(state) {
  return `
    <div class="card elev-sm" style="padding:0;overflow-x:auto">
      <div style="padding:14px"><h3 class="card-title" style="font-size:16px;margin:0">Inward History</h3></div>
      ${
        state.history.length === 0
          ? `<div style="padding:0 14px 14px;font-size:13px;color:var(--color-neutral-500)">No receipts logged yet for this PO.</div>`
          : `<table class="table" style="min-width:520px">
              <thead><tr><th>Date</th><th>Items</th><th>Notes</th></tr></thead>
              <tbody>
                ${state.history
                  .map(
                    (entry) => `
                  <tr data-history-row="${escapeHtml(entry.id)}">
                    <td>${escapeHtml(entry.received_date)}</td>
                    <td>${entry.line_items.map((li) => `${escapeHtml(li.po_line_item?.item_name || '')}: ${li.received_qty}`).join(', ')}</td>
                    <td>${escapeHtml(entry.notes || '—')}</td>
                  </tr>`
                  )
                  .join('')}
              </tbody>
            </table>`
      }
    </div>
  `;
}

function wireEvents(container, store, user, loadOrders, loadForPo) {
  container.querySelector('[data-action="select-po"]')?.addEventListener('change', async (e) => {
    const poId = e.target.value;
    store.setState({ poId, savedOk: false, saveError: null });
    await loadForPo(poId);
  });

  container.querySelector('[data-action="received-date"]')?.addEventListener('input', (e) => {
    store.setState({ receivedDate: e.target.value });
  });
  container.querySelector('[data-action="notes"]')?.addEventListener('input', (e) => {
    store.setState({ notes: e.target.value });
  });

  container.querySelectorAll('[data-action="received-qty"]').forEach((el) => {
    el.addEventListener('input', () => {
      const state = store.getState();
      store.setState({
        receivedQtyByLineItem: { ...state.receivedQtyByLineItem, [el.dataset.poLineItemId]: el.value },
      });
    });
  });

  container.querySelector('[data-action="save"]')?.addEventListener('click', async () => {
    const state = store.getState();
    const lineItems = state.lineItemStatus.map((row) => ({
      poLineItemId: row.po_line_item_id,
      receivedQty: state.receivedQtyByLineItem[row.po_line_item_id] ?? '',
      pendingQty: row.pending_qty,
    }));
    const { valid, errors } = validateInwardForm({ poId: state.poId, receivedDate: state.receivedDate, lineItems });
    if (!valid) {
      store.setState({ saveError: Object.values(errors)[0], savedOk: false });
      return;
    }

    store.setState({ saving: true, saveError: null });
    try {
      await createInward({
        poId: state.poId,
        receivedDate: state.receivedDate,
        notes: state.notes,
        receivedBy: user.id,
        lineItems: lineItems
          .filter((li) => String(li.receivedQty).trim() !== '')
          .map((li) => ({ poLineItemId: li.poLineItemId, receivedQty: Number(li.receivedQty) })),
      });
      store.setState({ saving: false, savedOk: true, notes: '' });
      await loadOrders();
      await loadForPo(state.poId);
    } catch (err) {
      store.setState({ saving: false, saveError: err.message || 'Could not log this receipt.' });
    }
  });
}
