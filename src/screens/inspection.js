// Inspection (Phase 3): accept or reject received material, in full or in
// part, with a rejection reason. Inspector/Admin only.
import { getCurrentProfile } from '../auth.js';
import { renderShell } from '../layout.js';
import { escapeHtml } from '../components.js';
import { createStore } from '../state.js';
import { canViewModule } from '../navPermissions.js';
import { fetchPendingInspection, recordInspection } from '../inspection.js';
import { validateInspectionForm } from '../validation.js';
import { repaintPreservingFocus } from '../domFocus.js';

function initialState() {
  return {
    pending: [],
    loading: true,
    error: false,
    openRowId: null,
    formsByRow: {},
    savingRowId: null,
    saveErrorByRow: {},
  };
}

export async function render(container) {
  const user = await getCurrentProfile();
  if (!user) {
    window.location.hash = '#/login';
    return;
  }
  if (!canViewModule('/inspection', user.role)) {
    window.location.hash = '#/dashboard';
    return;
  }

  const content = renderShell(container, { activeRoute: '/inspection', user });
  content.setAttribute('data-screen', 'inspection');
  const store = createStore(initialState());

  async function load() {
    store.setState({ loading: true, error: false });
    try {
      const pending = await fetchPendingInspection();
      store.setState({ pending, loading: false, error: false });
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
  await load();
}

function renderContent(container, state) {
  container.innerHTML = `
    <h1 style="margin-bottom:16px">Inspection</h1>

    <div class="card elev-sm" style="padding:0;overflow-x:auto">
      ${
        state.loading
          ? `<div style="padding:20px;font-size:13px;color:var(--color-neutral-500)">Loading…</div>`
          : state.error
            ? `<div style="padding:20px;text-align:center">
                <p style="font-size:13px;color:var(--color-accent-2-200);margin:0 0 10px">Couldn't load pending inspections.</p>
                <button type="button" class="btn btn-secondary" data-action="retry">Retry</button>
              </div>`
            : state.pending.length === 0
              ? `<div style="padding:20px;font-size:13px;color:var(--color-neutral-500)">Nothing is waiting on inspection right now.</div>`
              : `<table class="table" style="min-width:640px">
                  <thead><tr><th>PO Number</th><th>Project</th><th>Item</th><th>Received Date</th><th>Received Qty</th><th></th></tr></thead>
                  <tbody>${state.pending.map((row) => renderRow(row, state)).join('')}</tbody>
                </table>`
      }
    </div>
  `;
}

function renderRow(row, state) {
  const isOpen = state.openRowId === row.id;
  const rows = [
    `<tr data-inspection-row="${escapeHtml(row.id)}">
      <td>${escapeHtml(row.po_line_item?.po?.po_number || '—')}</td>
      <td>${escapeHtml(row.po_line_item?.po?.project?.name || '—')}</td>
      <td>${escapeHtml(row.po_line_item?.item_name || '—')}</td>
      <td>${escapeHtml(row.inward?.received_date || '—')}</td>
      <td>${row.received_qty}</td>
      <td><button type="button" class="btn btn-secondary" data-action="toggle-row" data-id="${escapeHtml(row.id)}" style="padding:4px 10px;font-size:12px">${isOpen ? 'Cancel' : 'Inspect'}</button></td>
    </tr>`,
  ];

  if (isOpen) {
    const form = state.formsByRow[row.id] || { acceptedQty: '', rejectedQty: '', rejectionReason: '' };
    const { valid, errors } = validateInspectionForm({ ...form, receivedQty: row.received_qty });
    const saveError = state.saveErrorByRow[row.id];
    rows.push(`
      <tr data-inspection-form="${escapeHtml(row.id)}">
        <td colspan="6" style="padding:12px 14px;background:var(--color-surface-2, transparent);border-top:1px solid var(--color-divider)">
          <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;align-items:end">
            <div class="field"><label>Accepted Qty</label>
              <input class="input" data-action="accepted-qty" data-id="${escapeHtml(row.id)}" type="text" inputmode="decimal" value="${escapeHtml(form.acceptedQty)}" style="${errors.acceptedQty ? 'border-color:var(--color-accent-2)' : ''}" />
            </div>
            <div class="field"><label>Rejected Qty</label>
              <input class="input" data-action="rejected-qty" data-id="${escapeHtml(row.id)}" type="text" inputmode="decimal" value="${escapeHtml(form.rejectedQty)}" style="${errors.rejectedQty ? 'border-color:var(--color-accent-2)' : ''}" />
            </div>
            <div class="field"><label>Rejection Reason${Number(form.rejectedQty) > 0 ? '' : ' (if any rejected)'}</label>
              <input class="input" data-action="rejection-reason" data-id="${escapeHtml(row.id)}" type="text" value="${escapeHtml(form.rejectionReason)}" style="${errors.rejectionReason ? 'border-color:var(--color-accent-2)' : ''}" />
            </div>
          </div>
          ${!valid ? `<p style="font-size:12px;color:var(--color-accent-2-200);margin:8px 0 0">${escapeHtml(Object.values(errors)[0])}</p>` : ''}
          ${saveError ? `<p data-role="inspection-save-error" style="font-size:12px;color:var(--color-accent-2-200);margin:8px 0 0">${escapeHtml(saveError)}</p>` : ''}
          <button type="button" class="btn btn-primary" data-action="save-inspection" data-id="${escapeHtml(row.id)}" style="margin-top:10px;padding:5px 14px;font-size:12px" ${state.savingRowId === row.id ? 'disabled' : ''}>${state.savingRowId === row.id ? 'Saving…' : 'Save Inspection'}</button>
        </td>
      </tr>
    `);
  }

  return rows.join('');
}

function wireEvents(container, store, user, load) {
  container.querySelector('[data-action="retry"]')?.addEventListener('click', load);

  container.querySelectorAll('[data-action="toggle-row"]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const state = store.getState();
      store.setState({ openRowId: state.openRowId === btn.dataset.id ? null : btn.dataset.id });
    });
  });

  const updateForm = (id, patch) => {
    const state = store.getState();
    const existing = state.formsByRow[id] || { acceptedQty: '', rejectedQty: '', rejectionReason: '' };
    store.setState({ formsByRow: { ...state.formsByRow, [id]: { ...existing, ...patch } } });
  };
  container.querySelectorAll('[data-action="accepted-qty"]').forEach((el) =>
    el.addEventListener('input', () => updateForm(el.dataset.id, { acceptedQty: el.value }))
  );
  container.querySelectorAll('[data-action="rejected-qty"]').forEach((el) =>
    el.addEventListener('input', () => updateForm(el.dataset.id, { rejectedQty: el.value }))
  );
  container.querySelectorAll('[data-action="rejection-reason"]').forEach((el) =>
    el.addEventListener('input', () => updateForm(el.dataset.id, { rejectionReason: el.value }))
  );

  container.querySelectorAll('[data-action="save-inspection"]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.id;
      const state = store.getState();
      const row = state.pending.find((r) => r.id === id);
      const form = state.formsByRow[id] || { acceptedQty: '', rejectedQty: '', rejectionReason: '' };
      const { valid, errors } = validateInspectionForm({ ...form, receivedQty: row.received_qty });
      if (!valid) {
        store.setState({ saveErrorByRow: { ...state.saveErrorByRow, [id]: Object.values(errors)[0] } });
        return;
      }

      store.setState({ savingRowId: id, saveErrorByRow: { ...state.saveErrorByRow, [id]: null } });
      try {
        await recordInspection({
          inwardLineItemId: id,
          acceptedQty: Number(form.acceptedQty),
          rejectedQty: Number(form.rejectedQty),
          rejectionReason: form.rejectionReason,
          inspectedBy: user.id,
        });
        store.setState({ savingRowId: null, openRowId: null });
        await load();
      } catch (err) {
        store.setState({
          savingRowId: null,
          saveErrorByRow: { ...store.getState().saveErrorByRow, [id]: err.message || 'Could not save this inspection.' },
        });
      }
    });
  });
}
