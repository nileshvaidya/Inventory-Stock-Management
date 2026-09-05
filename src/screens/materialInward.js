// Material Inward (Phase 3): log receipts against a PO, including partial
// deliveries across multiple inward entries. Store/Admin only.
import { getCurrentProfile } from '../auth.js';
import { renderShell } from '../layout.js';
import { escapeHtml } from '../components.js';
import { createStore } from '../state.js';
import { canViewModule } from '../navPermissions.js';
import {
  fetchReceivableOrders,
  fetchLineItemStatusForPo,
  createInward,
  fetchInwardHistory,
  uploadChallanFile,
  getChallanFileUrl,
} from '../materialInward.js';
import { validateInwardForm, validateInwardLineItem } from '../validation.js';
import { repaintPreservingFocus, afterFocusSettles } from '../domFocus.js';
import { extractPdfText, parseChallanText } from '../pdfParser.js';

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
    // The raw File object survives the state spread fine (setState only
    // shallow-merges) — kept until Save, since attaching it happens as a
    // separate step after the inward header row exists (uploadChallanFile
    // needs its id for the storage path).
    challanFile: null,
    challanFileName: '',
    challanParseNote: null,
    challanActionError: null,
    challanOcrBusy: false,
  };
}

/**
 * Matches parsed challan lines to this PO's own line items by (trimmed,
 * case-insensitive) item name — a challan lists what was physically
 * delivered, but "Receiving Now" is keyed by po_line_item_id, so a parsed
 * row is only useful once it's tied to a specific line on the selected PO.
 * Unmatched lines are simply not pre-filled, never guessed at.
 * @param {{ itemName: string, quantity: number }[]} parsedRows
 * @param {{ po_line_item_id: string, item_name: string }[]} lineItemStatus
 */
function matchChallanToLineItems(parsedRows, lineItemStatus) {
  const receivedQtyByLineItem = {};
  let matchedCount = 0;
  for (const row of parsedRows) {
    const target = lineItemStatus.find((li) => li.item_name.trim().toLowerCase() === row.itemName.trim().toLowerCase());
    if (target) {
      receivedQtyByLineItem[target.po_line_item_id] = String(row.quantity);
      matchedCount += 1;
    }
  }
  return { receivedQtyByLineItem, matchedCount, totalParsed: parsedRows.length };
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
    repaintPreservingFocus(content, () => {
      renderContent(content, store.getState());
      wireEvents(content, store, user, loadOrders, loadForPo);
    });
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
    ${state.challanActionError ? `<p data-role="challan-action-error" style="font-size:13px;color:var(--color-accent-2-200);background:var(--color-accent-2-900);border:1px solid var(--color-accent-2-700);border-radius:var(--radius-md);padding:8px 12px;margin-bottom:14px">${escapeHtml(state.challanActionError)}</p>` : ''}

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
      <div class="field" style="padding:0 14px 14px">
        <label for="mi-challan-file">Upload Delivery Challan (optional)</label>
        <input id="mi-challan-file" type="file" accept="application/pdf,image/*" data-action="challan-file" class="input" style="padding:6px" ${state.challanOcrBusy ? 'disabled' : ''} />
        <p style="font-size:12px;color:var(--color-neutral-500);margin-top:6px">Item and quantity are read automatically where possible and matched to the line items below — review and correct every row before saving.</p>
        ${state.challanFileName ? `<p style="font-size:12px;color:var(--color-neutral-500);margin-top:6px">Selected: ${escapeHtml(state.challanFileName)}</p>` : ''}
        ${state.challanOcrBusy ? `<p data-role="challan-ocr-busy" style="font-size:12px;color:var(--color-neutral-500);margin-top:4px">Scanning document for item/quantity lines… this can take up to a minute on a scanned/photographed file.</p>` : ''}
        ${!state.challanOcrBusy && state.challanParseNote ? `<p data-role="challan-parse-note" style="font-size:12px;color:var(--color-neutral-500);margin-top:4px">${escapeHtml(state.challanParseNote)}</p>` : ''}
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
      ${state.lineItemStatus.length > 0 ? `<div style="padding:0 14px 14px"><button type="button" class="btn btn-primary" data-action="save" ${state.saving || state.challanOcrBusy ? 'disabled' : ''}>${state.saving ? 'Saving…' : 'Log Receipt'}</button></div>` : ''}
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
        <input class="input" data-action="received-qty" data-po-line-item-id="${escapeHtml(row.po_line_item_id)}" type="text" inputmode="decimal" value="${escapeHtml(enteredQty)}" style="width:100px;${showError ? 'border-color:var(--color-accent-2)' : ''}" ${row.pending_qty <= 0 ? 'disabled' : ''} />
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
              <thead><tr><th>Date</th><th>Items</th><th>Notes</th><th>Challan</th></tr></thead>
              <tbody>
                ${state.history
                  .map(
                    (entry) => `
                  <tr data-history-row="${escapeHtml(entry.id)}">
                    <td>${escapeHtml(entry.received_date)}</td>
                    <td>${entry.line_items.map((li) => `${escapeHtml(li.po_line_item?.item_name || '')}: ${li.received_qty}`).join(', ')}</td>
                    <td>${escapeHtml(entry.notes || '—')}</td>
                    <td>${entry.challan_file_path ? `<button type="button" class="btn btn-ghost" data-action="view-challan" data-path="${escapeHtml(entry.challan_file_path)}" style="padding:4px 10px;font-size:12px">View</button>` : '—'}</td>
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
    store.setState({ poId, savedOk: false, saveError: null, challanFile: null, challanFileName: '', challanParseNote: null, challanActionError: null });
    await loadForPo(poId);
  });

  container.querySelector('[data-action="challan-file"]')?.addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const state = store.getState();
    store.setState({ challanFile: file, challanFileName: file.name, challanParseNote: null });

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
    // giving up and asking for manual entry. OCR is slow, so this is only
    // attempted once the fast, free path has already come up empty.
    if (!readFailed && parsedRows.length === 0) {
      store.setState({ challanOcrBusy: true });
      // Dynamically imported — OCR (tesseract.js) is a sizeable dependency
      // only worth fetching once a document actually needs this fallback,
      // not on every visit to this screen.
      const { ocrFile } = await import('../ocr.js');
      const ocrText = await ocrFile(file);
      // The user may have picked a different file while OCR was running —
      // don't clobber it with this stale result.
      if (store.getState().challanFile !== file) return;
      store.setState({ challanOcrBusy: false });
      if (ocrText) parsedRows = parseChallanText(ocrText);
    }

    if (readFailed) {
      store.setState({ challanParseNote: "Couldn't read this file — enter received quantities by hand below." });
      return;
    }
    if (parsedRows.length === 0) {
      store.setState({
        challanParseNote: "Couldn't find any recognizable item/qty lines in this document — enter quantities by hand below.",
      });
      return;
    }

    const { receivedQtyByLineItem, matchedCount, totalParsed } = matchChallanToLineItems(parsedRows, state.lineItemStatus);
    store.setState({
      receivedQtyByLineItem: { ...state.receivedQtyByLineItem, ...receivedQtyByLineItem },
      challanParseNote:
        matchedCount === 0
          ? "Couldn't match any lines in this document to an item on this PO — enter quantities by hand below."
          : `Matched ${matchedCount} of ${totalParsed} line(s) from the document to items on this PO — review before saving.`,
    });
  });

  // 'blur' rather than 'input'/'change': a native date picker's in-progress
  // segment (day/month/year) lives in the browser's own internal editing
  // state, which a full re-render (this screen's paint(), on every
  // store.setState) can't preserve the way repaintPreservingFocus does for
  // a text input's cursor position — re-rendering mid-edit silently wipes
  // whatever segment the user was typing. Chrome fires 'change' on this
  // element type on every completed segment, not just once at the end (as
  // was assumed in an earlier, insufficient fix here), so it re-renders
  // mid-edit just as often as 'input' did. 'blur' only fires once, after
  // the user is done with the field entirely, so no re-render ever
  // interrupts an in-progress edit. The setState itself is deferred via
  // afterFocusSettles: calling it synchronously inside 'blur' raced the
  // browser's own Tab-driven focus transfer and broke Tab navigation out
  // of this field — see domFocus.js.
  container.querySelector('[data-action="received-date"]')?.addEventListener('blur', (e) => {
    const value = e.target.value;
    afterFocusSettles(() => store.setState({ receivedDate: value }));
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
      const inward = await createInward({
        poId: state.poId,
        receivedDate: state.receivedDate,
        notes: state.notes,
        receivedBy: user.id,
        lineItems: lineItems
          .filter((li) => String(li.receivedQty).trim() !== '')
          .map((li) => ({ poLineItemId: li.poLineItemId, receivedQty: Number(li.receivedQty) })),
      });
      if (state.challanFile) {
        try {
          await uploadChallanFile(inward.id, state.challanFile);
        } catch {
          // The receipt itself is already logged — a failed attach is a
          // secondary, correctable problem, never a reason to make the
          // whole save look like it failed.
        }
      }
      store.setState({
        saving: false,
        savedOk: true,
        notes: '',
        challanFile: null,
        challanFileName: '',
        challanParseNote: null,
      });
      await loadOrders();
      await loadForPo(state.poId);
    } catch (err) {
      store.setState({ saving: false, saveError: err.message || 'Could not log this receipt.' });
    }
  });

  container.querySelectorAll('[data-action="view-challan"]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      try {
        const url = await getChallanFileUrl(btn.dataset.path);
        if (url) window.open(url, '_blank', 'noopener');
      } catch (err) {
        store.setState({ challanActionError: err.message || 'Could not open this file.' });
      }
    });
  });
}
