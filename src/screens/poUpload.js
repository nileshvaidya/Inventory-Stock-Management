// PO Upload (Phase 2): upload a PO PDF, review/edit the parsed line items,
// link to a Project/Order (create-inline if new) and optionally a Vendor
// (create-inline if new), then save. Admin/Purchase only (navPermissions).
import { getCurrentProfile } from '../auth.js';
import { renderShell } from '../layout.js';
import { escapeHtml } from '../components.js';
import { createStore } from '../state.js';
import { canViewModule } from '../navPermissions.js';
import { extractPdfText, parsePoText, parseStatedTotal, parsePoNumber, parseOrderDate } from '../pdfParser.js';
import { tokenizeLine, parseNumberToken, deriveColumnTemplate, applyColumnTemplate } from '../docMapping.js';
import { fetchProjects, createProject } from '../projects.js';
import { fetchVendors, createVendor } from '../vendors.js';
import { createPurchaseOrder } from '../purchaseOrders.js';
import { fetchMappingForVendor, saveMappingForVendor } from '../importMappings.js';
import { validatePurchaseOrderForm, validateLineItem } from '../validation.js';

const DOC_TYPE = 'purchase_order';

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
    // Manual field-mapping fallback (src/docMapping.js) for when parsing
    // doesn't recognize a vendor's layout — see wireEvents' map-* handlers.
    rawLines: [],
    mappingOpen: false,
    pasteText: '',
    mapLineIndex: null,
    mapActiveSlot: null,
    mapItemNameIndices: [],
    mapQtyIndex: null,
    mapRateIndex: null,
    lastDerivedTemplate: null,
    mappingSavedOk: false,
    mappingSaveError: null,
  };
}

/**
 * Runs both parsing strategies against extracted/pasted text and applies
 * the result to the form: pdfParser's regex heuristics first, falling back
 * to the vendor's saved column template (src/docMapping.js) if regexes
 * found nothing and a vendor is already selected. Shared by the file-input
 * handler and the "paste text" fallback so both go through the exact same
 * pipeline.
 * @param {{ getState: () => object, setState: (patch: object) => void }} store
 * @param {string} text
 * @param {{ fileName?: string }} [options]
 */
async function applyExtractedText(store, text, { fileName } = {}) {
  const parsedRows = parsePoText(text);
  const parsedPoNumber = parsePoNumber(text);
  const parsedOrderDate = parseOrderDate(text);
  const rawLines = text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

  const state = store.getState();
  let rows = parsedRows;
  if (rows.length === 0 && state.vendorId) {
    try {
      const template = await fetchMappingForVendor(DOC_TYPE, state.vendorId);
      rows = applyColumnTemplate(rawLines, template);
    } catch {
      // Best-effort fallback only — a lookup failure just means no
      // auto-applied template, never blocks the upload itself.
    }
  }

  store.setState({
    ...(fileName !== undefined ? { parsedFileName: fileName } : {}),
    parseError: rows.length === 0 ? "Couldn't find any recognizable item/qty/rate lines in this PDF." : null,
    lineItems: rows.map((r) => ({ itemName: r.itemName, quantity: r.quantity, rate: r.rate })),
    statedTotal: parseStatedTotal(text),
    poNumber: parsedPoNumber ?? '',
    orderDate: parsedOrderDate ?? todayISO(),
    rawLines,
    mappingOpen: rows.length === 0 ? true : state.mappingOpen,
  });
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
      ${state.parseError ? `<p data-role="parse-error" style="font-size:13px;color:var(--color-accent-2-200);margin-top:8px">${escapeHtml(state.parseError)} Add rows by hand below, or use "Map Fields Manually" to build them from the raw extracted text.</p>` : ''}
    </div>

    <div class="card elev-sm" style="margin-bottom:16px">
      <div style="display:flex;align-items:center;justify-content:space-between">
        <h3 class="card-title" style="font-size:16px;margin:0">Map Fields Manually</h3>
        <button type="button" class="btn btn-ghost" data-action="toggle-mapping" style="padding:4px 10px;font-size:12px">${state.mappingOpen ? 'Hide' : 'Show'}</button>
      </div>
      <p class="card-body" style="margin-top:4px">If a PDF's layout wasn't recognized, use the raw extracted text below to build line items by hand: click a line, then click its words to fill Item Name/Qty/Rate.</p>
      ${state.mappingOpen ? renderMappingPanel(state) : ''}
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

function renderMappingPanel(state) {
  const vendorName = state.vendors.find((v) => v.id === state.vendorId)?.name ?? '';
  return `
    <div style="margin-top:10px">
      <div class="field">
        <label for="paste-text">Or paste the PDF's text directly</label>
        <textarea class="input" id="paste-text" data-action="paste-text" rows="4" placeholder="Paste text copied from the PDF, one line per row…" style="width:100%">${escapeHtml(state.pasteText)}</textarea>
        <button type="button" class="btn btn-secondary" data-action="use-pasted-text" style="margin-top:6px;padding:4px 12px;font-size:12px">Use this text</button>
      </div>

      ${
        state.rawLines.length === 0
          ? `<p style="font-size:13px;color:var(--color-neutral-500);margin-top:10px">Upload a PDF or paste text above to see extracted lines here.</p>`
          : `<div style="margin-top:12px;max-height:220px;overflow-y:auto;border:1px solid var(--color-divider);border-radius:var(--radius-md)">
              ${state.rawLines
                .map(
                  (line, i) => `
                <div data-role="raw-line" style="padding:6px 10px;font-size:12px;border-bottom:1px solid var(--color-divider);display:flex;justify-content:space-between;gap:8px;align-items:center;${state.mapLineIndex === i ? 'background:var(--color-accent-900)' : ''}">
                  <span style="font-family:monospace;overflow-wrap:anywhere">${escapeHtml(line)}</span>
                  <button type="button" class="btn btn-ghost" data-action="select-map-line" data-index="${i}" style="padding:2px 8px;font-size:11px;white-space:nowrap">Map as item →</button>
                </div>`
                )
                .join('')}
            </div>`
      }

      ${state.mapLineIndex !== null && state.rawLines[state.mapLineIndex] !== undefined ? renderTokenMapper(state) : ''}

      ${
        state.lastDerivedTemplate
          ? `<div style="margin-top:12px;padding-top:10px;border-top:1px solid var(--color-divider)">
              ${
                state.vendorId
                  ? `<button type="button" class="btn btn-secondary" data-action="remember-layout" style="padding:5px 12px;font-size:12px">Remember this layout for ${escapeHtml(vendorName)}</button>`
                  : `<p style="font-size:12px;color:var(--color-neutral-500)">Select or create a Vendor above to remember this layout for future uploads.</p>`
              }
              ${state.mappingSavedOk ? `<p style="font-size:12px;color:var(--color-accent-100);margin-top:6px">Layout remembered — future uploads from this vendor will try it automatically.</p>` : ''}
              ${state.mappingSaveError ? `<p style="font-size:12px;color:var(--color-accent-2-200);margin-top:6px">${escapeHtml(state.mappingSaveError)}</p>` : ''}
            </div>`
          : ''
      }
    </div>
  `;
}

function renderTokenMapper(state) {
  const line = state.rawLines[state.mapLineIndex];
  const tokens = tokenizeLine(line);
  const itemNameText = state.mapItemNameIndices.map((i) => tokens[i]?.text ?? '').join(' ');
  const qtyText = state.mapQtyIndex !== null ? (tokens[state.mapQtyIndex]?.text ?? '') : '';
  const rateText = state.mapRateIndex !== null ? (tokens[state.mapRateIndex]?.text ?? '') : '';
  const canAdd = Boolean(itemNameText.trim() && qtyText && rateText);

  const slot = (key, label, valueText) => `
    <div class="field">
      <label>${label}</label>
      <div style="display:flex;gap:4px;align-items:center">
        <button type="button" class="btn ${state.mapActiveSlot === key ? 'btn-primary' : 'btn-secondary'}" data-action="set-active-slot" data-slot="${key}" style="padding:4px 8px;font-size:11px;flex:0 0 auto">Pick</button>
        <span style="font-size:12px">${escapeHtml(valueText) || '—'}</span>
      </div>
    </div>`;

  return `
    <div class="card" style="margin-top:12px;padding:12px">
      <p style="font-size:12px;color:var(--color-neutral-500);margin-bottom:6px">1. Pick a target below. 2. Click the word(s) in this line that belong to it.</p>
      <div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:10px" data-role="mapper-tokens">
        ${tokens.map((t) => `<button type="button" class="btn btn-secondary" data-action="map-token" data-token-index="${t.index}" style="padding:3px 8px;font-size:12px">${escapeHtml(t.text)}</button>`).join('')}
      </div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:8px">
        ${slot('itemName', 'Item Name', itemNameText)}
        ${slot('qty', 'Qty', qtyText)}
        ${slot('rate', 'Rate', rateText)}
      </div>
      <div style="margin-top:10px;display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        <button type="button" class="btn btn-primary" data-action="add-mapped-row" ${canAdd ? '' : 'disabled'} style="padding:5px 14px;font-size:12px">Add Row</button>
        <button type="button" class="btn btn-ghost" data-action="cancel-map-line" style="padding:5px 10px;font-size:12px">Cancel</button>
      </div>
    </div>
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
      // A newly selected file replaces the previous parse entirely, rather
      // than appending to it — each upload represents a single PO, so
      // switching files (before saving) means starting over with the new
      // one, not merging both POs' line items together.
      try {
        const text = await extractPdfText(file);
        await applyExtractedText(store, text, { fileName: file.name });
      } catch {
        store.setState({
          parsedFileName: file.name,
          parseError: "Couldn't read this PDF.",
          lineItems: store.getState().lineItems,
          mappingOpen: true,
        });
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

  container.querySelector('[data-action="toggle-mapping"]')?.addEventListener('click', () => {
    store.setState({ mappingOpen: !store.getState().mappingOpen });
  });

  container.querySelector('[data-action="paste-text"]')?.addEventListener('input', (e) => {
    store.setState({ pasteText: e.target.value });
  });

  container.querySelector('[data-action="use-pasted-text"]')?.addEventListener('click', async () => {
    const text = store.getState().pasteText;
    if (!text.trim()) return;
    await applyExtractedText(store, text);
  });

  container.querySelectorAll('[data-action="select-map-line"]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const index = Number(btn.dataset.index);
      store.setState({
        mapLineIndex: index,
        mapActiveSlot: 'itemName',
        mapItemNameIndices: [],
        mapQtyIndex: null,
        mapRateIndex: null,
      });
    });
  });

  container.querySelector('[data-action="cancel-map-line"]')?.addEventListener('click', () => {
    store.setState({ mapLineIndex: null, mapActiveSlot: null, mapItemNameIndices: [], mapQtyIndex: null, mapRateIndex: null });
  });

  container.querySelectorAll('[data-action="set-active-slot"]').forEach((btn) => {
    btn.addEventListener('click', () => {
      store.setState({ mapActiveSlot: btn.dataset.slot });
    });
  });

  container.querySelectorAll('[data-action="map-token"]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const state = store.getState();
      const tokenIndex = Number(btn.dataset.tokenIndex);
      // Assignments are mutually exclusive — picking a token for one slot
      // clears it from the others, so the same word can't silently end up
      // double-counted in, say, both Item Name and Qty.
      if (state.mapActiveSlot === 'itemName') {
        const already = state.mapItemNameIndices.includes(tokenIndex);
        const indices = already
          ? state.mapItemNameIndices.filter((i) => i !== tokenIndex)
          : [...state.mapItemNameIndices, tokenIndex].sort((a, b) => a - b);
        store.setState({
          mapItemNameIndices: indices,
          mapQtyIndex: state.mapQtyIndex === tokenIndex ? null : state.mapQtyIndex,
          mapRateIndex: state.mapRateIndex === tokenIndex ? null : state.mapRateIndex,
        });
      } else if (state.mapActiveSlot === 'qty') {
        store.setState({
          mapQtyIndex: tokenIndex,
          mapItemNameIndices: state.mapItemNameIndices.filter((i) => i !== tokenIndex),
          mapRateIndex: state.mapRateIndex === tokenIndex ? null : state.mapRateIndex,
        });
      } else if (state.mapActiveSlot === 'rate') {
        store.setState({
          mapRateIndex: tokenIndex,
          mapItemNameIndices: state.mapItemNameIndices.filter((i) => i !== tokenIndex),
          mapQtyIndex: state.mapQtyIndex === tokenIndex ? null : state.mapQtyIndex,
        });
      }
    });
  });

  container.querySelector('[data-action="add-mapped-row"]')?.addEventListener('click', () => {
    const state = store.getState();
    const line = state.rawLines[state.mapLineIndex];
    const tokens = tokenizeLine(line);
    const itemName = state.mapItemNameIndices
      .map((i) => tokens[i]?.text ?? '')
      .join(' ')
      .trim();
    const quantity = parseNumberToken(tokens[state.mapQtyIndex]?.text);
    const rate = parseNumberToken(tokens[state.mapRateIndex]?.text);
    if (!itemName || quantity === null || rate === null) return;

    const template = deriveColumnTemplate({
      tokenCount: tokens.length,
      itemNameTokenIndices: state.mapItemNameIndices,
      qtyTokenIndex: state.mapQtyIndex,
      rateTokenIndex: state.mapRateIndex,
    });

    store.setState({
      lineItems: [...state.lineItems, { itemName, quantity, rate }],
      lastDerivedTemplate: template,
      mapLineIndex: null,
      mapActiveSlot: null,
      mapItemNameIndices: [],
      mapQtyIndex: null,
      mapRateIndex: null,
      mappingSavedOk: false,
      mappingSaveError: null,
    });
  });

  container.querySelector('[data-action="remember-layout"]')?.addEventListener('click', async () => {
    const state = store.getState();
    if (!state.vendorId || !state.lastDerivedTemplate) return;
    try {
      await saveMappingForVendor(DOC_TYPE, state.vendorId, state.lastDerivedTemplate, user.id);
      store.setState({ mappingSavedOk: true, mappingSaveError: null });
    } catch (err) {
      store.setState({ mappingSaveError: err.message || 'Could not save this layout.', mappingSavedOk: false });
    }
  });

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
