// PO Upload (Phase 2): upload a PO PDF, review/edit the parsed line items,
// link to a Project/Order (create-inline if new) and optionally a Vendor
// (create-inline if new), then save. Admin/Purchase only (navPermissions).
import { getCurrentProfile } from '../auth.js';
import { renderShell } from '../layout.js';
import { escapeHtml } from '../components.js';
import { createStore } from '../state.js';
import { canViewModule } from '../navPermissions.js';
import { extractPdfText, parsePoText, parseStatedTotal, parsePoNumber, parseOrderDate } from '../pdfParser.js';
import { fetchProjects, createProject } from '../projects.js';
import { fetchVendors, createVendor } from '../vendors.js';
import { createPurchaseOrder } from '../purchaseOrders.js';
import { validatePurchaseOrderForm, validateLineItem } from '../validation.js';

const todayISO = () => new Date().toISOString().slice(0, 10);

function initialState() {
  return {
    projects: [],
    vendors: [],
    lineItems: [],
    parseError: null,
    parsedFileName: null,
    statedTotal: null,
    projectId: '',
    newProjectMode: false,
    newProjectName: '',
    vendorId: '',
    newVendorMode: false,
    newVendorName: '',
    newVendorGstin: '',
    newVendorContact: '',
    orderDate: todayISO(),
    poNumber: '',
    paymentTermsDays: '',
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
  if (!canViewModule('/po-upload', user.role)) {
    window.location.hash = '#/dashboard';
    return;
  }

  const content = renderShell(container, { activeRoute: '/po-upload', user });
  content.setAttribute('data-screen', 'po-upload');
  const store = createStore(initialState());

  async function loadLookups() {
    const [projects, vendors] = await Promise.all([fetchProjects(), fetchVendors()]);
    store.setState({ projects, vendors });
  }

  function paint() {
    renderContent(content, store.getState());
    wireEvents(content, store, user);
  }

  store.subscribe(paint);
  paint();
  await loadLookups();
}

function lineItemAmount(row) {
  const qty = Number(row.quantity);
  const rate = Number(row.rate);
  return Number.isFinite(qty) && Number.isFinite(rate) ? qty * rate : 0;
}

function computedTotal(lineItems) {
  return lineItems.reduce((sum, row) => sum + lineItemAmount(row), 0);
}

function renderContent(container, state) {
  const total = computedTotal(state.lineItems);
  const totalsMismatch =
    state.statedTotal !== null && Math.abs(total - state.statedTotal) > 0.01 && state.lineItems.length > 0;

  container.innerHTML = `
    <h1 style="margin-bottom:16px">PO Upload</h1>

    ${state.savedOk ? `<p style="font-size:13px;color:var(--color-accent-100);background:var(--color-accent-900);border:1px solid var(--color-accent-700);border-radius:var(--radius-md);padding:8px 12px;margin-bottom:14px">Purchase order saved.</p>` : ''}
    ${state.saveError ? `<p data-role="save-error" style="font-size:13px;color:var(--color-accent-2-200);background:var(--color-accent-2-900);border:1px solid var(--color-accent-2-700);border-radius:var(--radius-md);padding:8px 12px;margin-bottom:14px">${escapeHtml(state.saveError)}</p>` : ''}

    <div class="card elev-sm" style="margin-bottom:16px">
      <div class="card-kicker">Step 1</div>
      <h3 class="card-title" style="font-size:16px">Upload PO PDF</h3>
      <p class="card-body" style="margin-bottom:8px">Items, quantity, and rate are parsed automatically where possible — review and correct every row below before saving.</p>
      <input type="file" accept="application/pdf" data-action="pdf-file" class="input" style="padding:6px" />
      ${state.parsedFileName ? `<p style="font-size:12px;color:var(--color-neutral-500);margin-top:6px">Parsed: ${escapeHtml(state.parsedFileName)}</p>` : ''}
      ${state.parseError ? `<p data-role="parse-error" style="font-size:13px;color:var(--color-accent-2-200);margin-top:8px">${escapeHtml(state.parseError)} Add line items manually below instead.</p>` : ''}
    </div>

    <div class="card elev-sm" style="margin-bottom:16px;padding:0;overflow-x:auto">
      <div style="padding:14px;display:flex;align-items:center;justify-content:space-between">
        <h3 class="card-title" style="font-size:16px;margin:0">Line Items</h3>
        <button type="button" class="btn btn-secondary" data-action="add-row" style="padding:5px 12px;font-size:12px">+ Add Row</button>
      </div>
      ${
        state.lineItems.length === 0
          ? `<div style="padding:0 14px 14px;font-size:13px;color:var(--color-neutral-500)">No line items yet — upload a PDF or add a row manually.</div>`
          : `<table class="table" style="min-width:520px">
              <thead><tr><th>Item</th><th>Qty</th><th>Rate</th><th>Amount</th><th></th></tr></thead>
              <tbody>${state.lineItems.map((row, i) => renderLineItemRow(row, i)).join('')}</tbody>
            </table>`
      }
      <div style="padding:10px 14px;font-size:13px;border-top:1px solid var(--color-divider);display:flex;justify-content:flex-end;gap:16px">
        <span>Computed total: <strong>${total.toFixed(2)}</strong></span>
        ${state.statedTotal !== null ? `<span>PDF-stated total: <strong>${state.statedTotal.toFixed(2)}</strong></span>` : ''}
      </div>
      ${
        totalsMismatch
          ? `<div data-role="totals-warning" style="padding:10px 14px;font-size:13px;color:var(--color-accent-2-200);border-top:1px solid var(--color-divider)">Computed total doesn't match the PDF's stated total — doesn't block saving, just double-check the line items.</div>`
          : ''
      }
    </div>

    <div class="card elev-sm" style="margin-bottom:16px">
      <h3 class="card-title" style="font-size:16px">Details</h3>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px;margin-top:10px">
        <div class="field">
          <label for="po-project">Project / Order</label>
          ${
            state.newProjectMode
              ? `<div style="display:flex;gap:6px">
                  <input class="input" id="po-new-project-name" data-role="new-project-name" placeholder="New project name" value="${escapeHtml(state.newProjectName)}" />
                  <button type="button" class="btn btn-secondary" data-action="confirm-new-project" style="padding:0 10px">Add</button>
                  <button type="button" class="btn btn-ghost" data-action="cancel-new-project" style="padding:0 6px">✕</button>
                </div>`
              : `<div style="display:flex;gap:6px">
                  <select class="input" id="po-project" data-action="project-select">
                    <option value="">Select…</option>
                    ${state.projects.map((p) => `<option value="${escapeHtml(p.id)}" ${state.projectId === p.id ? 'selected' : ''}>${escapeHtml(p.name)}</option>`).join('')}
                  </select>
                  <button type="button" class="btn btn-secondary" data-action="new-project" style="padding:0 10px;white-space:nowrap">+ New</button>
                </div>`
          }
        </div>
        <div class="field">
          <label for="po-vendor">Vendor (optional)</label>
          ${
            state.newVendorMode
              ? `<div style="display:flex;flex-direction:column;gap:6px">
                  <input class="input" data-role="new-vendor-name" placeholder="Vendor name" value="${escapeHtml(state.newVendorName)}" />
                  <input class="input" data-role="new-vendor-gstin" placeholder="GSTIN (optional)" value="${escapeHtml(state.newVendorGstin)}" />
                  <input class="input" data-role="new-vendor-contact" placeholder="Contact (optional)" value="${escapeHtml(state.newVendorContact)}" />
                  <div style="display:flex;gap:6px">
                    <button type="button" class="btn btn-secondary" data-action="confirm-new-vendor" style="padding:0 10px">Add</button>
                    <button type="button" class="btn btn-ghost" data-action="cancel-new-vendor" style="padding:0 6px">✕</button>
                  </div>
                </div>`
              : `<div style="display:flex;gap:6px">
                  <select class="input" id="po-vendor" data-action="vendor-select">
                    <option value="">None</option>
                    ${state.vendors.map((v) => `<option value="${escapeHtml(v.id)}" ${state.vendorId === v.id ? 'selected' : ''}>${escapeHtml(v.name)}</option>`).join('')}
                  </select>
                  <button type="button" class="btn btn-secondary" data-action="new-vendor" style="padding:0 10px;white-space:nowrap">+ New</button>
                </div>`
          }
        </div>
        <div class="field"><label for="po-date">Order Date</label>
          <input class="input" id="po-date" type="date" data-action="order-date" value="${escapeHtml(state.orderDate)}" />
        </div>
        <div class="field"><label for="po-number">PO Number (optional)</label>
          <input class="input" id="po-number" type="text" data-action="po-number" value="${escapeHtml(state.poNumber)}" />
        </div>
        <div class="field"><label for="po-terms">Payment Terms (days, optional)</label>
          <input class="input" id="po-terms" type="number" min="0" step="1" data-action="payment-terms" value="${escapeHtml(state.paymentTermsDays)}" />
        </div>
      </div>
    </div>

    <button type="button" class="btn btn-primary" data-action="save" ${state.saving ? 'disabled' : ''}>${state.saving ? 'Saving…' : 'Save Purchase Order'}</button>
  `;
}

function renderLineItemRow(row, index) {
  const { valid, errors } = validateLineItem(row);
  const amount = lineItemAmount(row);
  return `
    <tr data-line-item-row="${index}">
      <td><input class="input" data-action="item-name" data-index="${index}" value="${escapeHtml(row.itemName)}" style="min-width:160px;${errors.itemName ? 'border-color:var(--color-accent-2)' : ''}" /></td>
      <td><input class="input" data-action="item-qty" data-index="${index}" type="number" step="any" value="${escapeHtml(row.quantity)}" style="width:90px;${errors.quantity ? 'border-color:var(--color-accent-2)' : ''}" /></td>
      <td><input class="input" data-action="item-rate" data-index="${index}" type="number" step="any" value="${escapeHtml(row.rate)}" style="width:90px;${errors.rate ? 'border-color:var(--color-accent-2)' : ''}" /></td>
      <td style="font-size:13px">${amount.toFixed(2)}</td>
      <td><button type="button" class="btn btn-ghost" data-action="remove-row" data-index="${index}" aria-label="Remove row">🗑</button></td>
    </tr>
    ${!valid ? `<tr><td colspan="5" style="padding:0 8px 8px;font-size:11px;color:var(--color-accent-2-200)">${escapeHtml(Object.values(errors)[0])}</td></tr>` : ''}
  `;
}

function wireEvents(container, store, user) {
  const fileInput = container.querySelector('[data-action="pdf-file"]');
  if (fileInput) {
    fileInput.addEventListener('change', async () => {
      const file = fileInput.files?.[0];
      if (!file) return;
      try {
        const text = await extractPdfText(file);
        const parsedRows = parsePoText(text);
        const parsedPoNumber = parsePoNumber(text);
        const parsedOrderDate = parseOrderDate(text);
        const current = store.getState();
        store.setState({
          parsedFileName: file.name,
          parseError: parsedRows.length === 0 ? "Couldn't find any recognizable item/qty/rate lines in this PDF." : null,
          lineItems: [...current.lineItems, ...parsedRows.map((r) => ({ itemName: r.itemName, quantity: r.quantity, rate: r.rate }))],
          statedTotal: parseStatedTotal(text),
          poNumber: parsedPoNumber ?? current.poNumber,
          orderDate: parsedOrderDate ?? current.orderDate,
        });
      } catch {
        store.setState({ parsedFileName: file.name, parseError: "Couldn't read this PDF.", lineItems: store.getState().lineItems });
      }
    });
  }

  container.querySelector('[data-action="add-row"]')?.addEventListener('click', () => {
    store.setState({ lineItems: [...store.getState().lineItems, { itemName: '', quantity: '', rate: '' }] });
  });

  container.querySelectorAll('[data-action="remove-row"]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const index = Number(btn.dataset.index);
      store.setState({ lineItems: store.getState().lineItems.filter((_, i) => i !== index) });
    });
  });

  const updateRow = (index, patch) => {
    const lineItems = store.getState().lineItems.map((row, i) => (i === index ? { ...row, ...patch } : row));
    store.setState({ lineItems });
  };
  container.querySelectorAll('[data-action="item-name"]').forEach((el) =>
    el.addEventListener('input', () => updateRow(Number(el.dataset.index), { itemName: el.value }))
  );
  container.querySelectorAll('[data-action="item-qty"]').forEach((el) =>
    el.addEventListener('input', () => updateRow(Number(el.dataset.index), { quantity: el.value }))
  );
  container.querySelectorAll('[data-action="item-rate"]').forEach((el) =>
    el.addEventListener('input', () => updateRow(Number(el.dataset.index), { rate: el.value }))
  );

  container.querySelector('[data-action="new-project"]')?.addEventListener('click', () => {
    store.setState({ newProjectMode: true, newProjectName: '' });
  });
  container.querySelector('[data-action="cancel-new-project"]')?.addEventListener('click', () => {
    store.setState({ newProjectMode: false });
  });
  container.querySelector('[data-role="new-project-name"]')?.addEventListener('input', (e) => {
    store.setState({ newProjectName: e.target.value });
  });
  container.querySelector('[data-action="confirm-new-project"]')?.addEventListener('click', async () => {
    const name = store.getState().newProjectName.trim();
    if (!name) return;
    const project = await createProject(name);
    store.setState({
      projects: [...store.getState().projects, project],
      projectId: project.id,
      newProjectMode: false,
    });
  });
  container.querySelector('[data-action="project-select"]')?.addEventListener('change', (e) => {
    store.setState({ projectId: e.target.value });
  });

  container.querySelector('[data-action="new-vendor"]')?.addEventListener('click', () => {
    store.setState({ newVendorMode: true, newVendorName: '', newVendorGstin: '', newVendorContact: '' });
  });
  container.querySelector('[data-action="cancel-new-vendor"]')?.addEventListener('click', () => {
    store.setState({ newVendorMode: false });
  });
  container.querySelector('[data-role="new-vendor-name"]')?.addEventListener('input', (e) => store.setState({ newVendorName: e.target.value }));
  container.querySelector('[data-role="new-vendor-gstin"]')?.addEventListener('input', (e) => store.setState({ newVendorGstin: e.target.value }));
  container.querySelector('[data-role="new-vendor-contact"]')?.addEventListener('input', (e) => store.setState({ newVendorContact: e.target.value }));
  container.querySelector('[data-action="confirm-new-vendor"]')?.addEventListener('click', async () => {
    const state = store.getState();
    const name = state.newVendorName.trim();
    if (!name) return;
    const vendor = await createVendor({ name, gstin: state.newVendorGstin, contact: state.newVendorContact });
    store.setState({ vendors: [...state.vendors, vendor], vendorId: vendor.id, newVendorMode: false });
  });
  container.querySelector('[data-action="vendor-select"]')?.addEventListener('change', (e) => {
    store.setState({ vendorId: e.target.value });
  });

  container.querySelector('[data-action="order-date"]')?.addEventListener('input', (e) => store.setState({ orderDate: e.target.value }));
  container.querySelector('[data-action="po-number"]')?.addEventListener('input', (e) => store.setState({ poNumber: e.target.value }));
  container.querySelector('[data-action="payment-terms"]')?.addEventListener('input', (e) => store.setState({ paymentTermsDays: e.target.value }));

  container.querySelector('[data-action="save"]')?.addEventListener('click', async () => {
    const state = store.getState();
    const { valid, errors } = validatePurchaseOrderForm(state);
    if (!valid) {
      store.setState({ saveError: Object.values(errors)[0], savedOk: false });
      return;
    }

    store.setState({ saving: true, saveError: null });
    try {
      await createPurchaseOrder({
        poNumber: state.poNumber,
        projectId: state.projectId,
        vendorId: state.vendorId || null,
        orderDate: state.orderDate,
        paymentTermsDays: state.paymentTermsDays === '' ? null : Number(state.paymentTermsDays),
        statedTotal: state.statedTotal,
        sourcePdfName: state.parsedFileName,
        createdBy: user.id,
        lineItems: state.lineItems.map((row) => ({
          itemName: row.itemName.trim(),
          quantity: Number(row.quantity),
          rate: Number(row.rate),
        })),
      });
      store.setState({ ...initialState(), projects: state.projects, vendors: state.vendors, savedOk: true, saving: false });
    } catch (err) {
      store.setState({ saving: false, saveError: err.message || 'Could not save the purchase order.' });
    }
  });
}
