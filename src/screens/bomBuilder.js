// BoM Builder (Phase 6): nested bills of materials + recording production.
// Admin/Production only, per navPermissions.js — everyone who can even
// see this screen already has manage rights, but action buttons are still
// gated on canManage here too (not just by RLS), matching this app's
// consistent double-enforcement pattern in case that ever changes.
//
// Recording production consumes only a recipe's own direct components —
// confirmed with the user before building — leaving multi-level BoM
// explosion to Phase 7's Work Orders. A shortfall on any component blocks
// the whole thing server-side (record_bom_production() RPC), not just in
// this screen.
import { getCurrentProfile } from '../auth.js';
import { renderShell } from '../layout.js';
import { escapeHtml } from '../components.js';
import { createStore } from '../state.js';
import { canViewModule } from '../navPermissions.js';
import { fetchBoms, fetchProductionRuns, createBom, updateBom, archiveBom, recordBomProduction } from '../boms.js';
import { fetchItems, createItem } from '../items.js';
import { validateBomForm, validateItemForm, validateProductionForm } from '../validation.js';
import { repaintPreservingFocus } from '../domFocus.js';

function emptyBomForm() {
  return { outputItemId: '', outputQty: '1', name: '', notes: '', components: [{ componentItemId: '', quantity: '' }] };
}

function initialState() {
  return {
    boms: [],
    items: [],
    loading: true,
    error: false,
    formMode: null, // null | 'create' | 'edit'
    editingBomId: null,
    form: emptyBomForm(),
    formError: null,
    saving: false,
    newItemMode: false,
    newItemName: '',
    newItemCategory: '',
    newItemUom: '',
    newItemReorderLevel: '',
    newItemError: null,
    openBomId: null,
    productionRunsByBom: {},
    productionFormByBom: {},
    productionErrorByBom: {},
    productionSuccessByBom: {},
    savingProductionBomId: null,
    archivingBomId: null,
  };
}

export async function render(container) {
  const user = await getCurrentProfile();
  if (!user) {
    window.location.hash = '#/login';
    return;
  }
  if (!canViewModule('/bom-builder', user.role)) {
    window.location.hash = '#/dashboard';
    return;
  }
  const canManage = user.role === 'admin' || user.role === 'production';

  const content = renderShell(container, { activeRoute: '/bom-builder', user });
  content.setAttribute('data-screen', 'bom-builder');
  const store = createStore(initialState());

  async function load() {
    store.setState({ loading: true, error: false });
    try {
      const [boms, items] = await Promise.all([fetchBoms(), fetchItems()]);
      store.setState({ boms, items, loading: false, error: false });
    } catch {
      store.setState({ loading: false, error: true });
    }
  }

  function paint() {
    repaintPreservingFocus(content, () => {
      renderContent(content, store.getState(), canManage);
      wireEvents(content, store, user, load, canManage);
    });
  }

  store.subscribe(paint);
  paint();
  await load();
}

function renderContent(container, state, canManage) {
  container.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;flex-wrap:wrap;gap:12px">
      <h1 style="margin:0">BoM Builder</h1>
      ${canManage && !state.formMode ? `<button type="button" class="btn btn-secondary" data-action="new-bom">+ New Recipe</button>` : ''}
    </div>

    ${state.formMode ? renderBomForm(state) : ''}

    <div class="card elev-sm" style="padding:0;overflow-x:auto">
      ${
        state.loading
          ? `<div style="padding:20px;font-size:13px;color:var(--color-neutral-500)">Loading…</div>`
          : state.error
            ? `<div style="padding:20px;text-align:center">
                <p style="font-size:13px;color:var(--color-accent-2-200);margin:0 0 10px">Couldn't load recipes.</p>
                <button type="button" class="btn btn-secondary" data-action="retry">Retry</button>
              </div>`
            : state.boms.length === 0
              ? `<div style="padding:20px;font-size:13px;color:var(--color-neutral-500)">No recipes yet.</div>`
              : `<table class="table" style="min-width:680px">
                  <thead><tr><th>Produces</th><th>Output Qty</th><th>Components</th><th></th></tr></thead>
                  <tbody>${state.boms.map((bom) => renderBomRow(bom, state, canManage)).join('')}</tbody>
                </table>`
      }
    </div>
  `;
}

function renderBomForm(state) {
  const { form } = state;
  const isEdit = state.formMode === 'edit';
  return `
    <div class="card elev-sm" style="margin-bottom:16px" data-role="bom-form">
      <h3 class="card-title" style="font-size:16px">${isEdit ? 'Edit Recipe' : 'New Recipe'}</h3>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;margin-top:10px">
        <div class="field"><label for="bom-output-item">Produces</label>
          <select class="input" id="bom-output-item" data-action="form-output-item" ${isEdit ? 'disabled' : ''}>
            <option value="">Select item…</option>
            ${state.items.map((i) => `<option value="${escapeHtml(i.id)}" ${form.outputItemId === i.id ? 'selected' : ''}>${escapeHtml(i.name)}</option>`).join('')}
          </select>
        </div>
        <div class="field"><label for="bom-output-qty">Output Qty (per batch)</label>
          <input class="input" id="bom-output-qty" type="text" inputmode="decimal" data-action="form-output-qty" value="${escapeHtml(form.outputQty)}" />
        </div>
        <div class="field"><label for="bom-name">Name (optional)</label>
          <input class="input" id="bom-name" data-action="form-name" value="${escapeHtml(form.name)}" />
        </div>
      </div>
      <div class="field" style="margin-top:10px"><label for="bom-notes">Notes (optional)</label>
        <textarea class="input" id="bom-notes" data-action="form-notes" rows="2">${escapeHtml(form.notes)}</textarea>
      </div>

      ${
        !isEdit
          ? `<div style="margin-top:10px">
              ${
                state.newItemMode
                  ? `<div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
                      <input class="input" data-role="new-item-name" placeholder="New item name" value="${escapeHtml(state.newItemName)}" style="padding:5px 8px;font-size:12px" />
                      <button type="button" class="btn btn-secondary" data-action="confirm-new-item" style="padding:5px 10px;font-size:12px">Add</button>
                      <button type="button" class="btn btn-ghost" data-action="cancel-new-item" style="padding:5px 8px;font-size:12px">✕</button>
                    </div>`
                  : `<button type="button" class="btn btn-ghost" data-action="new-item" style="padding:5px 10px;font-size:12px">+ New Item</button>`
              }
              ${state.newItemError ? `<p data-role="new-item-error" style="font-size:12px;color:var(--color-accent-2-200);margin-top:6px">${escapeHtml(state.newItemError)}</p>` : ''}
            </div>`
          : ''
      }

      <h4 style="margin:16px 0 8px;font-size:13px">Components</h4>
      <table class="table" style="min-width:480px">
        <thead><tr><th>Item</th><th>Qty per batch</th><th></th></tr></thead>
        <tbody>
          ${form.components
            .map(
              (row, idx) => `
            <tr data-component-row="${idx}">
              <td>
                <select class="input" data-action="component-item" data-idx="${idx}">
                  <option value="">Select item…</option>
                  ${state.items.map((i) => `<option value="${escapeHtml(i.id)}" ${row.componentItemId === i.id ? 'selected' : ''}>${escapeHtml(i.name)}</option>`).join('')}
                </select>
              </td>
              <td><input class="input" type="text" inputmode="decimal" style="width:100px" data-action="component-quantity" data-idx="${idx}" value="${escapeHtml(row.quantity)}" /></td>
              <td><button type="button" class="btn btn-ghost" data-action="remove-component" data-idx="${idx}" style="padding:4px 10px;font-size:12px">Remove</button></td>
            </tr>`
            )
            .join('')}
        </tbody>
      </table>
      <button type="button" class="btn btn-ghost" data-action="add-component" style="padding:5px 10px;font-size:12px;margin-top:8px">+ Add Component</button>

      ${state.formError ? `<p data-role="form-error" style="font-size:12px;color:var(--color-accent-2-200);margin-top:10px">${escapeHtml(state.formError)}</p>` : ''}
      <div style="margin-top:14px;display:flex;gap:8px">
        <button type="button" class="btn btn-primary" data-action="save-bom" ${state.saving ? 'disabled' : ''}>${state.saving ? 'Saving…' : 'Save Recipe'}</button>
        <button type="button" class="btn btn-ghost" data-action="cancel-form">Cancel</button>
      </div>
    </div>
  `;
}

function renderBomRow(bom, state, canManage) {
  const isOpen = state.openBomId === bom.id;
  const outputName = bom.output_item?.name || '—';
  const rows = [
    `<tr data-bom-row="${escapeHtml(bom.id)}">
      <td>${escapeHtml(outputName)}</td>
      <td>${bom.output_qty}${bom.output_item?.unit_of_measure ? ` ${escapeHtml(bom.output_item.unit_of_measure)}` : ''}</td>
      <td>${(bom.components || []).length}</td>
      <td><button type="button" class="btn btn-ghost" data-action="toggle-bom" data-id="${escapeHtml(bom.id)}" style="padding:4px 10px;font-size:12px">${isOpen ? 'Hide' : 'Details'}</button></td>
    </tr>`,
  ];

  if (isOpen) {
    rows.push(`
      <tr data-bom-detail-row="${escapeHtml(bom.id)}">
        <td colspan="4" style="padding:12px 14px;border-top:1px solid var(--color-divider)">
          ${renderBomDetail(bom, state, canManage)}
        </td>
      </tr>
    `);
  }

  return rows.join('');
}

function renderBomDetail(bom, state, canManage) {
  const components = bom.components || [];
  const runs = state.productionRunsByBom[bom.id];
  const prodForm = state.productionFormByBom[bom.id] || { quantityProduced: '', notes: '' };
  const prodError = state.productionErrorByBom[bom.id];
  const prodSuccess = state.productionSuccessByBom[bom.id];

  return `
    ${bom.name ? `<p style="font-size:13px;margin:0 0 6px"><strong>${escapeHtml(bom.name)}</strong></p>` : ''}
    ${bom.notes ? `<p style="font-size:12px;color:var(--color-neutral-500);margin:0 0 10px">${escapeHtml(bom.notes)}</p>` : ''}

    <table class="table" style="min-width:360px;margin-bottom:12px">
      <thead><tr><th>Component</th><th>Qty per batch</th></tr></thead>
      <tbody>
        ${components
          .map(
            (c) => `<tr><td>${escapeHtml(c.component_item?.name || '—')}</td><td>${c.quantity}${c.component_item?.unit_of_measure ? ` ${escapeHtml(c.component_item.unit_of_measure)}` : ''}</td></tr>`
          )
          .join('')}
      </tbody>
    </table>

    ${
      canManage
        ? `<div style="display:flex;gap:8px;margin-bottom:14px">
            <button type="button" class="btn btn-ghost" data-action="edit-bom" data-id="${escapeHtml(bom.id)}" style="padding:5px 12px;font-size:12px">Edit</button>
            <button type="button" class="btn btn-ghost" data-action="archive-bom" data-id="${escapeHtml(bom.id)}" style="padding:5px 12px;font-size:12px" ${state.archivingBomId === bom.id ? 'disabled' : ''}>Archive</button>
          </div>

          <h4 style="margin:0 0 8px;font-size:13px">Record Production</h4>
          <div style="display:flex;gap:8px;align-items:end;flex-wrap:wrap;margin-bottom:8px">
            <div class="field" style="margin:0"><label>Quantity Produced</label>
              <input class="input" type="text" inputmode="decimal" style="width:120px" data-action="production-quantity" data-id="${escapeHtml(bom.id)}" value="${escapeHtml(prodForm.quantityProduced)}" />
            </div>
            <div class="field" style="margin:0;flex:1;min-width:140px"><label>Notes</label>
              <input class="input" type="text" data-action="production-notes" data-id="${escapeHtml(bom.id)}" value="${escapeHtml(prodForm.notes)}" />
            </div>
            <button type="button" class="btn btn-secondary" data-action="save-production" data-id="${escapeHtml(bom.id)}" style="padding:6px 14px;font-size:12px" ${state.savingProductionBomId === bom.id ? 'disabled' : ''}>${state.savingProductionBomId === bom.id ? 'Recording…' : 'Record Production'}</button>
          </div>
          ${prodError ? `<p data-role="production-error" data-id="${escapeHtml(bom.id)}" style="font-size:12px;color:var(--color-accent-2-200);margin:0 0 10px">${escapeHtml(prodError)}</p>` : ''}
          ${prodSuccess ? `<p data-role="production-success" style="font-size:12px;color:var(--color-accent-500,green);margin:0 0 10px">Production recorded.</p>` : ''}`
        : ''
    }

    <h4 style="margin:12px 0 8px;font-size:13px">Production History</h4>
    ${
      runs === undefined
        ? `<p style="font-size:13px;color:var(--color-neutral-500)">Loading history…</p>`
        : runs.length === 0
          ? `<p style="font-size:13px;color:var(--color-neutral-500)">No production recorded yet.</p>`
          : `<table class="table" style="min-width:360px">
              <thead><tr><th>Date</th><th>Qty Produced</th><th>Notes</th></tr></thead>
              <tbody>
                ${runs
                  .map(
                    (r) => `<tr data-production-row="${escapeHtml(r.id)}"><td>${escapeHtml(new Date(r.created_at).toLocaleDateString())}</td><td>${r.quantity_produced}</td><td>${escapeHtml(r.notes || '—')}</td></tr>`
                  )
                  .join('')}
              </tbody>
            </table>`
    }
  `;
}

function wireEvents(container, store, user, load, canManage) {
  container.querySelector('[data-action="retry"]')?.addEventListener('click', load);

  container.querySelectorAll('[data-action="toggle-bom"]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const state = store.getState();
      const bomId = btn.dataset.id;
      if (state.openBomId === bomId) {
        store.setState({ openBomId: null });
        return;
      }
      store.setState({ openBomId: bomId });
      if (!state.productionRunsByBom[bomId]) {
        const runs = await fetchProductionRuns(bomId);
        store.setState({ productionRunsByBom: { ...store.getState().productionRunsByBom, [bomId]: runs } });
      }
    });
  });

  if (!canManage) return;

  container.querySelector('[data-action="new-bom"]')?.addEventListener('click', () => {
    store.setState({ formMode: 'create', editingBomId: null, form: emptyBomForm(), formError: null, newItemMode: false });
  });

  container.querySelectorAll('[data-action="edit-bom"]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const bom = store.getState().boms.find((b) => b.id === btn.dataset.id);
      if (!bom) return;
      store.setState({
        formMode: 'edit',
        editingBomId: bom.id,
        form: {
          outputItemId: bom.output_item_id,
          outputQty: String(bom.output_qty),
          name: bom.name || '',
          notes: bom.notes || '',
          components: (bom.components || []).map((c) => ({ componentItemId: c.component_item_id, quantity: String(c.quantity) })),
        },
        formError: null,
      });
    });
  });

  container.querySelectorAll('[data-action="archive-bom"]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const bomId = btn.dataset.id;
      store.setState({ archivingBomId: bomId });
      try {
        await archiveBom(bomId);
        store.setState({ archivingBomId: null, openBomId: null });
        await load();
      } catch (err) {
        store.setState({ archivingBomId: null });
        window.alert(err.message || 'Could not archive this recipe.');
      }
    });
  });

  container.querySelector('[data-action="cancel-form"]')?.addEventListener('click', () => {
    store.setState({ formMode: null, editingBomId: null, formError: null, newItemMode: false });
  });

  container.querySelector('[data-action="form-output-item"]')?.addEventListener('change', (e) => {
    const state = store.getState();
    store.setState({ form: { ...state.form, outputItemId: e.target.value } });
  });
  container.querySelector('[data-action="form-output-qty"]')?.addEventListener('input', (e) => {
    const state = store.getState();
    store.setState({ form: { ...state.form, outputQty: e.target.value } });
  });
  container.querySelector('[data-action="form-name"]')?.addEventListener('input', (e) => {
    const state = store.getState();
    store.setState({ form: { ...state.form, name: e.target.value } });
  });
  container.querySelector('[data-action="form-notes"]')?.addEventListener('input', (e) => {
    const state = store.getState();
    store.setState({ form: { ...state.form, notes: e.target.value } });
  });

  container.querySelectorAll('[data-action="component-item"]').forEach((el) => {
    el.addEventListener('change', () => {
      const state = store.getState();
      const components = state.form.components.map((row, i) => (i === Number(el.dataset.idx) ? { ...row, componentItemId: el.value } : row));
      store.setState({ form: { ...state.form, components } });
    });
  });
  container.querySelectorAll('[data-action="component-quantity"]').forEach((el) => {
    el.addEventListener('input', () => {
      const state = store.getState();
      const components = state.form.components.map((row, i) => (i === Number(el.dataset.idx) ? { ...row, quantity: el.value } : row));
      store.setState({ form: { ...state.form, components } });
    });
  });
  container.querySelectorAll('[data-action="remove-component"]').forEach((el) => {
    el.addEventListener('click', () => {
      const state = store.getState();
      const components = state.form.components.filter((_, i) => i !== Number(el.dataset.idx));
      store.setState({ form: { ...state.form, components } });
    });
  });
  container.querySelector('[data-action="add-component"]')?.addEventListener('click', () => {
    const state = store.getState();
    store.setState({ form: { ...state.form, components: [...state.form.components, { componentItemId: '', quantity: '' }] } });
  });

  container.querySelector('[data-action="new-item"]')?.addEventListener('click', () => {
    store.setState({ newItemMode: true, newItemName: '', newItemError: null });
  });
  container.querySelector('[data-action="cancel-new-item"]')?.addEventListener('click', () => {
    store.setState({ newItemMode: false });
  });
  container.querySelector('[data-role="new-item-name"]')?.addEventListener('input', (e) => {
    store.setState({ newItemName: e.target.value });
  });
  container.querySelector('[data-action="confirm-new-item"]')?.addEventListener('click', async () => {
    const state = store.getState();
    const { valid, errors } = validateItemForm({ name: state.newItemName });
    if (!valid) {
      store.setState({ newItemError: Object.values(errors)[0] });
      return;
    }
    try {
      const item = await createItem({ name: state.newItemName.trim() });
      const items = await fetchItems();
      store.setState({ items, newItemMode: false, form: { ...store.getState().form, outputItemId: item.id } });
    } catch (err) {
      store.setState({ newItemError: err.message || 'Could not create this item.' });
    }
  });

  container.querySelector('[data-action="save-bom"]')?.addEventListener('click', async () => {
    const state = store.getState();
    const { valid, errors } = validateBomForm(state.form);
    if (!valid) {
      store.setState({ formError: Object.values(errors)[0] });
      return;
    }
    store.setState({ saving: true, formError: null });
    try {
      const payload = {
        outputItemId: state.form.outputItemId,
        outputQty: Number(state.form.outputQty),
        name: state.form.name,
        notes: state.form.notes,
        components: state.form.components.map((c) => ({ componentItemId: c.componentItemId, quantity: Number(c.quantity) })),
      };
      if (state.formMode === 'edit') {
        await updateBom(state.editingBomId, payload);
      } else {
        await createBom({ ...payload, createdBy: user.id });
      }
      store.setState({ saving: false, formMode: null, editingBomId: null });
      await load();
    } catch (err) {
      store.setState({ saving: false, formError: err.message || 'Could not save this recipe.' });
    }
  });

  container.querySelectorAll('[data-action="production-quantity"]').forEach((el) => {
    el.addEventListener('input', () => {
      const state = store.getState();
      const bomId = el.dataset.id;
      const existing = state.productionFormByBom[bomId] || { quantityProduced: '', notes: '' };
      store.setState({ productionFormByBom: { ...state.productionFormByBom, [bomId]: { ...existing, quantityProduced: el.value } } });
    });
  });
  container.querySelectorAll('[data-action="production-notes"]').forEach((el) => {
    el.addEventListener('input', () => {
      const state = store.getState();
      const bomId = el.dataset.id;
      const existing = state.productionFormByBom[bomId] || { quantityProduced: '', notes: '' };
      store.setState({ productionFormByBom: { ...state.productionFormByBom, [bomId]: { ...existing, notes: el.value } } });
    });
  });

  container.querySelectorAll('[data-action="save-production"]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const bomId = btn.dataset.id;
      const state = store.getState();
      const form = state.productionFormByBom[bomId] || { quantityProduced: '', notes: '' };
      const { valid, errors } = validateProductionForm(form);
      if (!valid) {
        store.setState({ productionErrorByBom: { ...state.productionErrorByBom, [bomId]: Object.values(errors)[0] }, productionSuccessByBom: { ...state.productionSuccessByBom, [bomId]: false } });
        return;
      }

      store.setState({
        savingProductionBomId: bomId,
        productionErrorByBom: { ...state.productionErrorByBom, [bomId]: null },
        productionSuccessByBom: { ...state.productionSuccessByBom, [bomId]: false },
      });
      try {
        await recordBomProduction(bomId, { quantityProduced: Number(form.quantityProduced), notes: form.notes });
        const runs = await fetchProductionRuns(bomId);
        store.setState({
          savingProductionBomId: null,
          productionRunsByBom: { ...store.getState().productionRunsByBom, [bomId]: runs },
          productionFormByBom: { ...store.getState().productionFormByBom, [bomId]: { quantityProduced: '', notes: '' } },
          productionSuccessByBom: { ...store.getState().productionSuccessByBom, [bomId]: true },
        });
      } catch (err) {
        store.setState({
          savingProductionBomId: null,
          productionErrorByBom: { ...store.getState().productionErrorByBom, [bomId]: err.message || 'Could not record production.' },
        });
      }
    });
  });
}
