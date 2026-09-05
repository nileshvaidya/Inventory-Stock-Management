// Inventory (Phase 4): current stock by item, filterable by name/category/
// below-reorder, with a per-item movement ledger. Admin/Store/Production —
// Production is read-only in practice (manual movements are store/admin
// only server-side via RLS; the button is simply not shown to Production).
//
// Reads available_stock (Phase 7), not the plain current_stock view — the
// same rows plus reserved_qty/available_qty netted against active work
// order reservations, so "below reorder" and the displayed quantity both
// reflect what's actually free to use, not just what's physically on hand.
import { getCurrentProfile } from '../auth.js';
import { renderShell } from '../layout.js';
import { escapeHtml } from '../components.js';
import { createStore } from '../state.js';
import { canViewModule } from '../navPermissions.js';
import { fetchAvailableStock, fetchMovementsForItem, createStockMovement } from '../inventory.js';
import { createItem } from '../items.js';
import { validateItemForm, validateStockMovementForm } from '../validation.js';
import { repaintPreservingFocus } from '../domFocus.js';

function initialState() {
  return {
    stock: [],
    loading: true,
    error: false,
    nameFilter: '',
    categoryFilter: '',
    belowReorderOnly: false,
    openItemId: null,
    movementsByItem: {},
    movementFormsByItem: {},
    savingMovementItemId: null,
    movementErrorByItem: {},
    newItemMode: false,
    newItemName: '',
    newItemCategory: '',
    newItemUom: '',
    newItemReorderLevel: '',
    newItemError: null,
  };
}

export async function render(container) {
  const user = await getCurrentProfile();
  if (!user) {
    window.location.hash = '#/login';
    return;
  }
  if (!canViewModule('/inventory', user.role)) {
    window.location.hash = '#/dashboard';
    return;
  }
  const canManageStock = user.role === 'admin' || user.role === 'store';

  const content = renderShell(container, { activeRoute: '/inventory', user });
  content.setAttribute('data-screen', 'inventory');
  const store = createStore(initialState());

  async function load() {
    store.setState({ loading: true, error: false });
    try {
      const stock = await fetchAvailableStock();
      store.setState({ stock, loading: false, error: false });
    } catch {
      store.setState({ loading: false, error: true });
    }
  }

  function paint() {
    repaintPreservingFocus(content, () => {
      renderContent(content, store.getState(), canManageStock);
      wireEvents(content, store, user, load, canManageStock);
    });
  }

  store.subscribe(paint);
  paint();
  await load();
}

function categoriesOf(stock) {
  return [...new Set(stock.map((row) => row.category).filter(Boolean))].sort();
}

function filteredStock(state) {
  return state.stock.filter((row) => {
    if (state.nameFilter && !row.name.toLowerCase().includes(state.nameFilter.toLowerCase())) return false;
    if (state.categoryFilter && row.category !== state.categoryFilter) return false;
    if (state.belowReorderOnly && !(row.reorder_level !== null && Number(row.available_qty) < Number(row.reorder_level))) {
      return false;
    }
    return true;
  });
}

function renderContent(container, state, canManageStock) {
  const rows = filteredStock(state);
  const categories = categoriesOf(state.stock);

  container.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;flex-wrap:wrap;gap:12px">
      <h1 style="margin:0">Inventory</h1>
      ${canManageStock ? `<button type="button" class="btn btn-secondary" data-action="new-item">+ New Item</button>` : ''}
    </div>

    ${canManageStock && state.newItemMode ? renderNewItemCard(state) : ''}

    <div class="card elev-sm" style="margin-bottom:16px">
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;align-items:end">
        <div class="field"><label for="inv-filter-name">Name</label>
          <input class="input" id="inv-filter-name" type="text" data-action="filter-name" value="${escapeHtml(state.nameFilter)}" placeholder="Search items…" />
        </div>
        <div class="field"><label for="inv-filter-category">Category</label>
          <select class="input" id="inv-filter-category" data-action="filter-category">
            <option value="">All</option>
            ${categories.map((c) => `<option value="${escapeHtml(c)}" ${state.categoryFilter === c ? 'selected' : ''}>${escapeHtml(c)}</option>`).join('')}
          </select>
        </div>
        <label style="display:flex;align-items:center;gap:6px;font-size:13px;padding-bottom:8px">
          <input type="checkbox" data-action="filter-below-reorder" ${state.belowReorderOnly ? 'checked' : ''} /> Below reorder level only
        </label>
      </div>
    </div>

    <div class="card elev-sm" style="padding:0;overflow-x:auto">
      ${
        state.loading
          ? `<div style="padding:20px;font-size:13px;color:var(--color-neutral-500)">Loading…</div>`
          : state.error
            ? `<div style="padding:20px;text-align:center">
                <p style="font-size:13px;color:var(--color-accent-2-200);margin:0 0 10px">Couldn't load inventory.</p>
                <button type="button" class="btn btn-secondary" data-action="retry">Retry</button>
              </div>`
            : rows.length === 0
              ? `<div style="padding:20px;font-size:13px;color:var(--color-neutral-500)">No items match these filters.</div>`
              : `<table class="table" style="min-width:820px">
                  <thead><tr><th>Item</th><th>Category</th><th>UoM</th><th>Current Stock</th><th>Reserved</th><th>Available</th><th>Reorder Level</th><th></th></tr></thead>
                  <tbody>${rows.map((row) => renderRow(row, state, canManageStock)).join('')}</tbody>
                </table>`
      }
    </div>
  `;
}

function renderNewItemCard(state) {
  return `
    <div class="card elev-sm" style="margin-bottom:16px">
      <h3 class="card-title" style="font-size:16px">New Item</h3>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;margin-top:10px">
        <div class="field"><label for="ni-name">Name</label>
          <input class="input" id="ni-name" data-action="new-item-name" value="${escapeHtml(state.newItemName)}" />
        </div>
        <div class="field"><label for="ni-category">Category (optional)</label>
          <input class="input" id="ni-category" data-action="new-item-category" value="${escapeHtml(state.newItemCategory)}" />
        </div>
        <div class="field"><label for="ni-uom">Unit of Measure (optional)</label>
          <input class="input" id="ni-uom" data-action="new-item-uom" value="${escapeHtml(state.newItemUom)}" placeholder="Nos., Kg, ..." />
        </div>
        <div class="field"><label for="ni-reorder">Reorder Level (optional)</label>
          <input class="input" id="ni-reorder" type="text" inputmode="decimal" data-action="new-item-reorder" value="${escapeHtml(state.newItemReorderLevel)}" />
        </div>
      </div>
      ${state.newItemError ? `<p data-role="new-item-error" style="font-size:12px;color:var(--color-accent-2-200);margin-top:8px">${escapeHtml(state.newItemError)}</p>` : ''}
      <div style="margin-top:10px;display:flex;gap:8px">
        <button type="button" class="btn btn-primary" data-action="confirm-new-item" style="padding:5px 14px;font-size:12px">Add Item</button>
        <button type="button" class="btn btn-ghost" data-action="cancel-new-item" style="padding:5px 10px;font-size:12px">Cancel</button>
      </div>
    </div>
  `;
}

function renderRow(row, state, canManageStock) {
  const belowReorder = row.reorder_level !== null && Number(row.available_qty) < Number(row.reorder_level);
  const isOpen = state.openItemId === row.item_id;
  const rows = [
    `<tr data-stock-row="${escapeHtml(row.item_id)}">
      <td>${escapeHtml(row.name)}</td>
      <td>${escapeHtml(row.category || '—')}</td>
      <td>${escapeHtml(row.unit_of_measure || '—')}</td>
      <td>${row.current_qty}</td>
      <td>${row.reserved_qty}</td>
      <td>${row.available_qty}${belowReorder ? ` <span class="tag tag-accent-2" data-role="below-reorder">Below reorder</span>` : ''}</td>
      <td>${row.reorder_level ?? '—'}</td>
      <td><button type="button" class="btn btn-ghost" data-action="toggle-item" data-id="${escapeHtml(row.item_id)}" style="padding:4px 10px;font-size:12px">${isOpen ? 'Hide' : 'Ledger'}</button></td>
    </tr>`,
  ];

  if (isOpen) {
    rows.push(`
      <tr data-ledger-row="${escapeHtml(row.item_id)}">
        <td colspan="8" style="padding:12px 14px;border-top:1px solid var(--color-divider)">
          ${renderLedger(row.item_id, state, canManageStock)}
        </td>
      </tr>
    `);
  }

  return rows.join('');
}

function renderLedger(itemId, state, canManageStock) {
  const movements = state.movementsByItem[itemId];
  const form = state.movementFormsByItem[itemId] || { movementType: 'in', quantity: '', notes: '' };
  const error = state.movementErrorByItem[itemId];

  return `
    ${
      canManageStock
        ? `<div style="display:flex;gap:8px;align-items:end;flex-wrap:wrap;margin-bottom:12px">
            <div class="field" style="margin:0"><label>Type</label>
              <select class="input" data-action="movement-type" data-id="${escapeHtml(itemId)}">
                <option value="in" ${form.movementType === 'in' ? 'selected' : ''}>In</option>
                <option value="out" ${form.movementType === 'out' ? 'selected' : ''}>Out</option>
              </select>
            </div>
            <div class="field" style="margin:0"><label>Quantity</label>
              <input class="input" type="text" inputmode="decimal" style="width:100px" data-action="movement-quantity" data-id="${escapeHtml(itemId)}" value="${escapeHtml(form.quantity)}" />
            </div>
            <div class="field" style="margin:0;flex:1;min-width:140px"><label>Notes</label>
              <input class="input" type="text" data-action="movement-notes" data-id="${escapeHtml(itemId)}" value="${escapeHtml(form.notes)}" placeholder="Opening balance, correction, ..." />
            </div>
            <button type="button" class="btn btn-secondary" data-action="save-movement" data-id="${escapeHtml(itemId)}" style="padding:6px 14px;font-size:12px">Log Movement</button>
          </div>
          ${error ? `<p data-role="movement-error" style="font-size:12px;color:var(--color-accent-2-200);margin:0 0 10px">${escapeHtml(error)}</p>` : ''}`
        : ''
    }
    ${
      movements === undefined
        ? `<p style="font-size:13px;color:var(--color-neutral-500)">Loading ledger…</p>`
        : movements.length === 0
          ? `<p style="font-size:13px;color:var(--color-neutral-500)">No movements recorded yet.</p>`
          : `<table class="table" style="min-width:480px">
              <thead><tr><th>Date</th><th>Type</th><th>Qty</th><th>Reference</th><th>Notes</th></tr></thead>
              <tbody>
                ${movements
                  .map(
                    (m) => `
                  <tr data-movement-row="${escapeHtml(m.id)}">
                    <td>${escapeHtml(new Date(m.created_at).toLocaleDateString())}</td>
                    <td>${m.movement_type === 'in' ? 'In' : 'Out'}</td>
                    <td>${m.quantity}</td>
                    <td>${escapeHtml(m.reference_type || 'Manual')}</td>
                    <td>${escapeHtml(m.notes || '—')}</td>
                  </tr>`
                  )
                  .join('')}
              </tbody>
            </table>`
    }
  `;
}

function wireEvents(container, store, user, load, canManageStock) {
  container.querySelector('[data-action="retry"]')?.addEventListener('click', load);

  container.querySelector('[data-action="filter-name"]')?.addEventListener('input', (e) => {
    store.setState({ nameFilter: e.target.value });
  });
  container.querySelector('[data-action="filter-category"]')?.addEventListener('change', (e) => {
    store.setState({ categoryFilter: e.target.value });
  });
  container.querySelector('[data-action="filter-below-reorder"]')?.addEventListener('change', (e) => {
    store.setState({ belowReorderOnly: e.target.checked });
  });

  container.querySelector('[data-action="new-item"]')?.addEventListener('click', () => {
    store.setState({ newItemMode: true, newItemName: '', newItemCategory: '', newItemUom: '', newItemReorderLevel: '', newItemError: null });
  });
  container.querySelector('[data-action="cancel-new-item"]')?.addEventListener('click', () => {
    store.setState({ newItemMode: false });
  });
  container.querySelector('[data-action="new-item-name"]')?.addEventListener('input', (e) => store.setState({ newItemName: e.target.value }));
  container.querySelector('[data-action="new-item-category"]')?.addEventListener('input', (e) => store.setState({ newItemCategory: e.target.value }));
  container.querySelector('[data-action="new-item-uom"]')?.addEventListener('input', (e) => store.setState({ newItemUom: e.target.value }));
  container.querySelector('[data-action="new-item-reorder"]')?.addEventListener('input', (e) => store.setState({ newItemReorderLevel: e.target.value }));
  container.querySelector('[data-action="confirm-new-item"]')?.addEventListener('click', async () => {
    const state = store.getState();
    const { valid, errors } = validateItemForm({ name: state.newItemName, reorderLevel: state.newItemReorderLevel });
    if (!valid) {
      store.setState({ newItemError: Object.values(errors)[0] });
      return;
    }
    try {
      await createItem({
        name: state.newItemName.trim(),
        category: state.newItemCategory,
        unitOfMeasure: state.newItemUom,
        reorderLevel: state.newItemReorderLevel === '' ? null : Number(state.newItemReorderLevel),
      });
      store.setState({ newItemMode: false });
      await load();
    } catch (err) {
      store.setState({ newItemError: err.message || 'Could not create this item.' });
    }
  });

  container.querySelectorAll('[data-action="toggle-item"]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const state = store.getState();
      const itemId = btn.dataset.id;
      if (state.openItemId === itemId) {
        store.setState({ openItemId: null });
        return;
      }
      store.setState({ openItemId: itemId });
      if (!state.movementsByItem[itemId]) {
        const movements = await fetchMovementsForItem(itemId);
        store.setState({ movementsByItem: { ...store.getState().movementsByItem, [itemId]: movements } });
      }
    });
  });

  if (!canManageStock) return;

  const updateMovementForm = (itemId, patch) => {
    const state = store.getState();
    const existing = state.movementFormsByItem[itemId] || { movementType: 'in', quantity: '', notes: '' };
    store.setState({ movementFormsByItem: { ...state.movementFormsByItem, [itemId]: { ...existing, ...patch } } });
  };
  container.querySelectorAll('[data-action="movement-type"]').forEach((el) =>
    el.addEventListener('change', () => updateMovementForm(el.dataset.id, { movementType: el.value }))
  );
  container.querySelectorAll('[data-action="movement-quantity"]').forEach((el) =>
    el.addEventListener('input', () => updateMovementForm(el.dataset.id, { quantity: el.value }))
  );
  container.querySelectorAll('[data-action="movement-notes"]').forEach((el) =>
    el.addEventListener('input', () => updateMovementForm(el.dataset.id, { notes: el.value }))
  );

  container.querySelectorAll('[data-action="save-movement"]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const itemId = btn.dataset.id;
      const state = store.getState();
      const form = state.movementFormsByItem[itemId] || { movementType: 'in', quantity: '', notes: '' };
      const { valid, errors } = validateStockMovementForm({ itemId, movementType: form.movementType, quantity: form.quantity });
      if (!valid) {
        store.setState({ movementErrorByItem: { ...state.movementErrorByItem, [itemId]: Object.values(errors)[0] } });
        return;
      }

      store.setState({ savingMovementItemId: itemId, movementErrorByItem: { ...state.movementErrorByItem, [itemId]: null } });
      try {
        await createStockMovement({
          itemId,
          movementType: form.movementType,
          quantity: Number(form.quantity),
          notes: form.notes,
          createdBy: user.id,
        });
        const [movements, stock] = await Promise.all([fetchMovementsForItem(itemId), fetchAvailableStock()]);
        store.setState({
          savingMovementItemId: null,
          stock,
          movementsByItem: { ...store.getState().movementsByItem, [itemId]: movements },
          movementFormsByItem: { ...store.getState().movementFormsByItem, [itemId]: { movementType: 'in', quantity: '', notes: '' } },
        });
      } catch (err) {
        store.setState({
          savingMovementItemId: null,
          movementErrorByItem: { ...store.getState().movementErrorByItem, [itemId]: err.message || 'Could not log this movement.' },
        });
      }
    });
  });
}
