// Work Orders (Phase 7): explode a nested BoM (netting against available
// stock at every level, not just the leaves), preview what it would take
// to produce a quantity of an item, then optionally reserve the stock
// that's currently on hand for it. Admin/Production/Store, per
// navPermissions.js — every visitor of this screen already has manage
// rights (same situation as BoM Builder), but action buttons are still
// gated on that role check locally too, matching this app's usual
// double-enforcement.
//
// This phase stops at plan + reserve — completing/fulfilling a work order
// (turning its reservation into an actual production run) still happens
// one recipe at a time via Phase 6's BoM Builder; Cancel here just
// releases the hold, it never touches stock_movements.
import { getCurrentProfile } from '../auth.js';
import { renderShell } from '../layout.js';
import { escapeHtml } from '../components.js';
import { createStore } from '../state.js';
import { canViewModule } from '../navPermissions.js';
import { fetchWorkOrders, fetchWorkOrderRequirements, previewExplosion, createWorkOrder, reserveWorkOrder, cancelWorkOrder } from '../workOrders.js';
import { fetchItems } from '../items.js';
import { validateWorkOrderForm } from '../validation.js';
import { repaintPreservingFocus } from '../domFocus.js';

const STATUS_LABELS = { open: 'Open', reserved: 'Reserved', cancelled: 'Cancelled' };
const STATUS_TAG_CLASSES = { open: 'tag-neutral', reserved: 'tag-accent', cancelled: 'tag-accent-2' };

function emptyForm() {
  return { outputItemId: '', quantity: '', notes: '' };
}

function initialState() {
  return {
    workOrders: [],
    items: [],
    loading: true,
    error: false,
    formMode: false,
    form: emptyForm(),
    formError: null,
    saving: false,
    preview: null,
    previewLoading: false,
    previewError: null,
    openWorkOrderId: null,
    requirementsByWorkOrder: {},
    reservingId: null,
    reserveErrorByWorkOrder: {},
    cancellingId: null,
  };
}

export async function render(container) {
  const user = await getCurrentProfile();
  if (!user) {
    window.location.hash = '#/login';
    return;
  }
  if (!canViewModule('/work-orders', user.role)) {
    window.location.hash = '#/dashboard';
    return;
  }
  const canManage = user.role === 'admin' || user.role === 'production' || user.role === 'store';

  const content = renderShell(container, { activeRoute: '/work-orders', user });
  content.setAttribute('data-screen', 'work-orders');
  const store = createStore(initialState());

  async function load() {
    store.setState({ loading: true, error: false });
    try {
      const [workOrders, items] = await Promise.all([fetchWorkOrders(), fetchItems()]);
      store.setState({ workOrders, items, loading: false, error: false });
    } catch {
      store.setState({ loading: false, error: true });
    }
  }

  function paint() {
    repaintPreservingFocus(content, () => {
      renderContent(content, store.getState(), canManage);
      wireEvents(content, store, load, canManage);
    });
  }

  store.subscribe(paint);
  paint();
  await load();
}

function renderContent(container, state, canManage) {
  container.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;flex-wrap:wrap;gap:12px">
      <h1 style="margin:0">Work Orders</h1>
      ${canManage && !state.formMode ? `<button type="button" class="btn btn-secondary" data-action="new-wo">+ New Work Order</button>` : ''}
    </div>

    ${state.formMode ? renderForm(state) : ''}

    <div class="card elev-sm" style="padding:0;overflow-x:auto">
      ${
        state.loading
          ? `<div style="padding:20px;font-size:13px;color:var(--color-neutral-500)">Loading…</div>`
          : state.error
            ? `<div style="padding:20px;text-align:center">
                <p style="font-size:13px;color:var(--color-accent-2-200);margin:0 0 10px">Couldn't load work orders.</p>
                <button type="button" class="btn btn-secondary" data-action="retry">Retry</button>
              </div>`
            : state.workOrders.length === 0
              ? `<div style="padding:20px;font-size:13px;color:var(--color-neutral-500)">No work orders yet.</div>`
              : `<table class="table" style="min-width:680px">
                  <thead><tr><th>Produces</th><th>Qty</th><th>Status</th><th>Created</th><th></th></tr></thead>
                  <tbody>${state.workOrders.map((wo) => renderWorkOrderRow(wo, state, canManage)).join('')}</tbody>
                </table>`
      }
    </div>
  `;
}

function renderForm(state) {
  const { form } = state;
  return `
    <div class="card elev-sm" style="margin-bottom:16px" data-role="wo-form">
      <h3 class="card-title" style="font-size:16px">New Work Order</h3>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;margin-top:10px">
        <div class="field"><label for="wo-output-item">Produces</label>
          <select class="input" id="wo-output-item" data-action="form-output-item">
            <option value="">Select item…</option>
            ${state.items.map((i) => `<option value="${escapeHtml(i.id)}" ${form.outputItemId === i.id ? 'selected' : ''}>${escapeHtml(i.name)}</option>`).join('')}
          </select>
        </div>
        <div class="field"><label for="wo-quantity">Quantity</label>
          <input class="input" id="wo-quantity" type="text" inputmode="decimal" data-action="form-quantity" value="${escapeHtml(form.quantity)}" />
        </div>
      </div>
      <div class="field" style="margin-top:10px"><label for="wo-notes">Notes (optional)</label>
        <textarea class="input" id="wo-notes" data-action="form-notes" rows="2">${escapeHtml(form.notes)}</textarea>
      </div>

      <div style="margin-top:10px;display:flex;gap:8px">
        <button type="button" class="btn btn-ghost" data-action="check-availability" style="padding:6px 14px;font-size:12px" ${state.previewLoading ? 'disabled' : ''}>${state.previewLoading ? 'Checking…' : 'Check Availability'}</button>
      </div>
      ${state.previewError ? `<p data-role="preview-error" style="font-size:12px;color:var(--color-accent-2-200);margin-top:10px">${escapeHtml(state.previewError)}</p>` : ''}
      ${state.preview ? renderPreview(state.preview) : ''}

      ${state.formError ? `<p data-role="form-error" style="font-size:12px;color:var(--color-accent-2-200);margin-top:10px">${escapeHtml(state.formError)}</p>` : ''}
      <div style="margin-top:14px;display:flex;gap:8px">
        <button type="button" class="btn btn-primary" data-action="save-wo" ${state.saving ? 'disabled' : ''}>${state.saving ? 'Creating…' : 'Create Work Order'}</button>
        <button type="button" class="btn btn-ghost" data-action="cancel-form">Cancel</button>
      </div>
    </div>
  `;
}

function renderPreview(preview) {
  if (preview.length === 0) {
    return `<p style="font-size:13px;color:var(--color-neutral-500);margin-top:10px">Nothing needed — fully covered by current stock.</p>`;
  }
  return `
    <table class="table" style="min-width:420px;margin-top:10px" data-role="preview-table">
      <thead><tr><th>Item</th><th>Reservable</th><th>Shortfall</th></tr></thead>
      <tbody>
        ${preview
          .map(
            (row) => `
          <tr data-preview-row="${escapeHtml(row.item_id)}">
            <td>${escapeHtml(row.item_name)}</td>
            <td>${row.reservable_qty}</td>
            <td>${Number(row.shortfall_qty) > 0 ? `<span class="tag tag-accent-2">${row.shortfall_qty} short</span>` : '—'}</td>
          </tr>`
          )
          .join('')}
      </tbody>
    </table>
  `;
}

function renderWorkOrderRow(wo, state, canManage) {
  const isOpen = state.openWorkOrderId === wo.id;
  const outputName = wo.output_item?.name || '—';
  const rows = [
    `<tr data-wo-row="${escapeHtml(wo.id)}">
      <td>${escapeHtml(outputName)}</td>
      <td>${wo.quantity}${wo.output_item?.unit_of_measure ? ` ${escapeHtml(wo.output_item.unit_of_measure)}` : ''}</td>
      <td><span class="tag ${STATUS_TAG_CLASSES[wo.status] || 'tag-neutral'}" data-role="wo-status">${STATUS_LABELS[wo.status] || wo.status}</span></td>
      <td>${escapeHtml(new Date(wo.created_at).toLocaleDateString())}</td>
      <td><button type="button" class="btn btn-ghost" data-action="toggle-wo" data-id="${escapeHtml(wo.id)}" style="padding:4px 10px;font-size:12px">${isOpen ? 'Hide' : 'Details'}</button></td>
    </tr>`,
  ];

  if (isOpen) {
    rows.push(`
      <tr data-wo-detail-row="${escapeHtml(wo.id)}">
        <td colspan="5" style="padding:12px 14px;border-top:1px solid var(--color-divider)">
          ${renderWorkOrderDetail(wo, state, canManage)}
        </td>
      </tr>
    `);
  }

  return rows.join('');
}

function renderWorkOrderDetail(wo, state, canManage) {
  const requirements = state.requirementsByWorkOrder[wo.id];
  const reserveError = state.reserveErrorByWorkOrder[wo.id];

  return `
    ${wo.notes ? `<p style="font-size:12px;color:var(--color-neutral-500);margin:0 0 10px">${escapeHtml(wo.notes)}</p>` : ''}

    ${
      requirements === undefined
        ? `<p style="font-size:13px;color:var(--color-neutral-500)">Loading requirements…</p>`
        : requirements.length === 0
          ? `<p style="font-size:13px;color:var(--color-neutral-500)">No components required.</p>`
          : `<table class="table" style="min-width:420px;margin-bottom:12px">
              <thead><tr><th>Item</th><th>Reservable</th><th>Shortfall</th></tr></thead>
              <tbody>
                ${requirements
                  .map(
                    (r) => `<tr><td>${escapeHtml(r.item?.name || '—')}</td><td>${r.reservable_qty}</td><td>${Number(r.shortfall_qty) > 0 ? `<span class="tag tag-accent-2">${r.shortfall_qty} short</span>` : '—'}</td></tr>`
                  )
                  .join('')}
              </tbody>
            </table>`
    }

    ${
      canManage && wo.status !== 'cancelled'
        ? `<div style="display:flex;gap:8px">
            ${
              wo.status === 'open'
                ? `<button type="button" class="btn btn-secondary" data-action="reserve-wo" data-id="${escapeHtml(wo.id)}" style="padding:5px 12px;font-size:12px" ${state.reservingId === wo.id ? 'disabled' : ''}>${state.reservingId === wo.id ? 'Reserving…' : 'Reserve Stock'}</button>`
                : ''
            }
            <button type="button" class="btn btn-ghost" data-action="cancel-wo" data-id="${escapeHtml(wo.id)}" style="padding:5px 12px;font-size:12px" ${state.cancellingId === wo.id ? 'disabled' : ''}>Cancel Work Order</button>
          </div>
          ${reserveError ? `<p data-role="reserve-error" data-id="${escapeHtml(wo.id)}" style="font-size:12px;color:var(--color-accent-2-200);margin-top:8px">${escapeHtml(reserveError)}</p>` : ''}`
        : ''
    }
  `;
}

function wireEvents(container, store, load, canManage) {
  container.querySelector('[data-action="retry"]')?.addEventListener('click', load);

  container.querySelectorAll('[data-action="toggle-wo"]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const state = store.getState();
      const woId = btn.dataset.id;
      if (state.openWorkOrderId === woId) {
        store.setState({ openWorkOrderId: null });
        return;
      }
      store.setState({ openWorkOrderId: woId });
      if (!state.requirementsByWorkOrder[woId]) {
        const requirements = await fetchWorkOrderRequirements(woId);
        store.setState({ requirementsByWorkOrder: { ...store.getState().requirementsByWorkOrder, [woId]: requirements } });
      }
    });
  });

  if (!canManage) return;

  container.querySelector('[data-action="new-wo"]')?.addEventListener('click', () => {
    store.setState({ formMode: true, form: emptyForm(), formError: null, preview: null, previewError: null });
  });
  container.querySelector('[data-action="cancel-form"]')?.addEventListener('click', () => {
    store.setState({ formMode: false });
  });

  container.querySelector('[data-action="form-output-item"]')?.addEventListener('change', (e) => {
    const state = store.getState();
    store.setState({ form: { ...state.form, outputItemId: e.target.value }, preview: null, previewError: null });
  });
  container.querySelector('[data-action="form-quantity"]')?.addEventListener('input', (e) => {
    const state = store.getState();
    store.setState({ form: { ...state.form, quantity: e.target.value }, preview: null, previewError: null });
  });
  container.querySelector('[data-action="form-notes"]')?.addEventListener('input', (e) => {
    const state = store.getState();
    store.setState({ form: { ...state.form, notes: e.target.value } });
  });

  container.querySelector('[data-action="check-availability"]')?.addEventListener('click', async () => {
    const state = store.getState();
    const { valid, errors } = validateWorkOrderForm(state.form);
    if (!valid) {
      store.setState({ previewError: Object.values(errors)[0] });
      return;
    }
    store.setState({ previewLoading: true, previewError: null });
    try {
      const preview = await previewExplosion(state.form.outputItemId, Number(state.form.quantity));
      store.setState({ previewLoading: false, preview });
    } catch (err) {
      store.setState({ previewLoading: false, previewError: err.message || 'Could not check availability.' });
    }
  });

  container.querySelector('[data-action="save-wo"]')?.addEventListener('click', async () => {
    const state = store.getState();
    const { valid, errors } = validateWorkOrderForm(state.form);
    if (!valid) {
      store.setState({ formError: Object.values(errors)[0] });
      return;
    }
    store.setState({ saving: true, formError: null });
    try {
      await createWorkOrder({ outputItemId: state.form.outputItemId, quantity: Number(state.form.quantity), notes: state.form.notes });
      store.setState({ saving: false, formMode: false });
      await load();
    } catch (err) {
      store.setState({ saving: false, formError: err.message || 'Could not create this work order.' });
    }
  });

  container.querySelectorAll('[data-action="reserve-wo"]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const woId = btn.dataset.id;
      const state = store.getState();
      store.setState({ reservingId: woId, reserveErrorByWorkOrder: { ...state.reserveErrorByWorkOrder, [woId]: null } });
      try {
        await reserveWorkOrder(woId);
        await load();
        store.setState({ reservingId: null, openWorkOrderId: woId });
      } catch (err) {
        store.setState({
          reservingId: null,
          reserveErrorByWorkOrder: { ...store.getState().reserveErrorByWorkOrder, [woId]: err.message || 'Could not reserve stock for this work order.' },
        });
      }
    });
  });

  container.querySelectorAll('[data-action="cancel-wo"]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const woId = btn.dataset.id;
      store.setState({ cancellingId: woId });
      try {
        await cancelWorkOrder(woId);
        await load();
        store.setState({ cancellingId: null });
      } catch (err) {
        store.setState({ cancellingId: null });
        window.alert(err.message || 'Could not cancel this work order.');
      }
    });
  });
}
