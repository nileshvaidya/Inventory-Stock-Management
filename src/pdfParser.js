// PO PDF parsing (Phase 2). Three parts, deliberately separate:
//   - extractPdfText(): pdf.js text extraction from a File — impure, needs
//     a real PDF, not unit-testable without a binary fixture.
//   - parsePoText() / parseStatedTotal() / parsePoNumber() / parseOrderDate():
//     pure regex heuristics over the extracted text — unit-testable
//     directly, no PDF involved.
// Calibrated against a real Odoo-style Indian PO (see CHANGELOG). Every row
// parsePoText produces is editable/deletable in the review step, and rows
// can be added by hand, so a bad or empty parse never blocks creating a PO.
import * as pdfjsLib from 'pdfjs-dist';
import pdfjsWorker from 'pdfjs-dist/build/pdf.worker.mjs?url';

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsWorker;

// pdf.js's getTextContent() returns one item per positioned text run, with
// NO inherent line breaks — items on the same visual line are just
// separate items with (roughly) the same Y coordinate. Naively
// space-joining every item (the original implementation) collapses an
// entire page into one line, which breaks every downstream regex that
// expects one line item per line. This reconstructs real lines from each
// item's transform matrix: transform[5] is Y (PDF Y increases upward, so
// sort descending for top-to-bottom reading order), transform[4] is X
// (sort ascending within a line for left-to-right reading order).
const Y_TOLERANCE = 2;

function reconstructLines(items) {
  const positioned = items
    .filter((item) => 'str' in item && item.str.trim() !== '')
    .map((item) => ({ str: item.str, x: item.transform[4], y: item.transform[5] }))
    .sort((a, b) => b.y - a.y);

  const rows = [];
  for (const item of positioned) {
    const row = rows[rows.length - 1];
    if (row && Math.abs(row.y - item.y) <= Y_TOLERANCE) {
      row.items.push(item);
    } else {
      rows.push({ y: item.y, items: [item] });
    }
  }

  return rows.map((row) =>
    row.items
      .sort((a, b) => a.x - b.x)
      .map((i) => i.str)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim()
  );
}

/**
 * @param {File} file
 * @returns {Promise<string>} raw extracted text, one reconstructed line per
 *   row, empty string if the PDF has no extractable text layer (e.g. a
 *   scanned image with no OCR) — never throws for that case, only for a
 *   file that isn't a readable PDF at all (P2-6: malformed PDF).
 */
export async function extractPdfText(file) {
  const buffer = await file.arrayBuffer();
  const doc = await pdfjsLib.getDocument({ data: buffer }).promise;
  const pageTexts = [];
  for (let pageNum = 1; pageNum <= doc.numPages; pageNum += 1) {
    const page = await doc.getPage(pageNum);
    const content = await page.getTextContent();
    pageTexts.push(reconstructLines(content.items).join('\n'));
  }
  return pageTexts.join('\n');
}

// Quantity and rate must be separated by at least one real whitespace
// character (the optional x/@/* marker sits inside that whitespace, never
// replaces it) — without a mandatory \s+ here, greedy backtracking can
// satisfy the pattern by splitting a single number like "10" into "1" and
// "0" with zero characters between them, which is nonsense, not a parse.
// Simple format: "<description> <qty> <rate>", no thousands separators, no
// unit-of-measure column, nothing after the rate.
const LINE_ITEM_RE = /^(.{2,80}?)\s+(\d+(?:\.\d+)?)\s+(?:[x@*]\s*)?(\d+(?:\.\d+)?)\s*$/;

// Real-world format (calibrated against an actual Odoo-generated PO):
// "<description> <qty, comma-formatted> <unit-of-measure> <rate, comma-formatted> <...discount/tax/amount columns, ignored>".
// e.g. "Base Angle   1,500.00   Nos.   45.00   0.00 %   GST 18%   ₹   67,500.00".
// Trailing columns are matched but not captured — every real PO line has
// more columns than description/qty/rate, and requiring an exact end of
// line (like LINE_ITEM_RE) would never match a real one.
const LINE_ITEM_WITH_UOM_RE =
  /^(.{2,80}?)\s+([\d,]+(?:\.\d+)?)\s+[A-Za-z][A-Za-z.]*\s+([\d,]+(?:\.\d+)?)(?:\s+.*)?$/;

function toNumber(raw) {
  const value = Number(String(raw).replace(/,/g, ''));
  return Number.isFinite(value) ? value : null;
}

// A "+<digits>" token is a phone-country-code marker (e.g. "+91 90228
// 17411" in a supplier's contact block) — real-world POs put these on
// their own line, and a bare "<digits> <digits>" shape otherwise matches
// the item/qty/rate pattern just as well as a real line item does. Skip
// any line containing one rather than risk a bogus row a user has to
// notice and delete by hand.
const PHONE_NUMBER_RE = /\+\d/;

function matchLineItem(line) {
  if (PHONE_NUMBER_RE.test(line)) return null;
  const simple = line.match(LINE_ITEM_RE);
  const match = simple ?? line.match(LINE_ITEM_WITH_UOM_RE);
  if (!match) return null;

  const [, rawName, rawQty, rawRate] = match;
  const itemName = rawName.trim();
  const quantity = toNumber(rawQty);
  const rate = toNumber(rawRate);
  if (!itemName || quantity === null || quantity <= 0 || rate === null || rate < 0) {
    return null;
  }
  return { itemName, quantity, rate };
}

/**
 * Heuristic: a line matching "<description> <qty> <rate>" (optionally with
 * an x/@/* separator, or a unit-of-measure column and trailing discount/
 * tax/amount columns, as real POs have) becomes one line item. Lines that
 * don't match are ignored rather than erroring — this is a best-effort
 * pass, not a guarantee.
 * @param {string} text
 * @returns {{ itemName: string, quantity: number, rate: number }[]}
 */
export function parsePoText(text) {
  if (!text || !text.trim()) return [];

  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map(matchLineItem)
    .filter(Boolean);
}

function extractAmountAfterLabel(text, labelPattern) {
  const match = text.match(new RegExp(`${labelPattern}[^\\d]*([\\d,]+(?:\\.\\d+)?)`, 'i'));
  if (!match) return null;
  return toNumber(match[1]);
}

/**
 * Looks for a stated total to cross-check against the sum of parsed line
 * items (P2-7). Prefers "Untaxed Amount" (the pre-tax subtotal) over
 * "Total" when both are present — line items are entered pre-tax, so
 * "Total" (which real Indian POs state tax-inclusive, e.g. with GST added)
 * is the wrong basis for that comparison and would show a false mismatch
 * on every taxed PO. Handles a leading currency symbol (₹) and
 * comma-formatted thousands. Returns null if no total line is found — the
 * totals check is then simply skipped rather than treated as a mismatch.
 * @param {string} text
 * @returns {number|null}
 */
export function parseStatedTotal(text) {
  if (!text) return null;
  return extractAmountAfterLabel(text, 'untaxed\\s+amount') ?? extractAmountAfterLabel(text, '\\b(?:grand\\s+)?total\\b');
}

/**
 * Looks for a "Purchase Order # <number>" line to pre-fill the PO Number
 * field. Returns null if not found — the field is always editable by hand.
 * @param {string} text
 * @returns {string|null}
 */
export function parsePoNumber(text) {
  if (!text) return null;
  const match = text.match(/purchase\s+order\s*#?\s*[:-]?\s*([A-Za-z0-9/-]+)/i);
  return match ? match[1] : null;
}

/**
 * Shared by parseOrderDate/parseInvoiceDate: looks for `labelPattern`
 * followed by a DD/MM/YYYY date (Indian date format), converting to ISO
 * (YYYY-MM-DD) for a date input. The label and its value are often on
 * different reconstructed lines — real documents commonly lay this out as
 * a multi-column table ("Buyer | Order Date: | Expected Arrival:" as one
 * row, values below) rather than "<Label>: <value>" inline — so this
 * allows a bounded gap of other text between the label and the first date
 * that follows it, rather than requiring them adjacent.
 * @param {string} text
 * @param {string} labelPattern
 * @returns {string|null}
 */
function extractDateAfterLabel(text, labelPattern) {
  const match = text.match(new RegExp(`${labelPattern}\\s*:?[\\s\\S]{0,80}?(\\d{1,2})/(\\d{1,2})/(\\d{2,4})`, 'i'));
  if (!match) return null;
  const [, dd, mm, yyyy] = match;
  const year = yyyy.length === 2 ? `20${yyyy}` : yyyy;
  const iso = `${year}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}`;
  return Number.isNaN(Date.parse(iso)) ? null : iso;
}

/**
 * Looks for an "Order Date:" label to pre-fill PO Upload's Order Date
 * field. Returns null if not found or unparsable — the field is always
 * editable by hand.
 * @param {string} text
 * @returns {string|null}
 */
export function parseOrderDate(text) {
  if (!text) return null;
  return extractDateAfterLabel(text, 'order\\s+date');
}

/**
 * Looks for an "Invoice Date:" label to pre-fill Invoices' "Upload
 * Invoice" flow. Same shape as parseOrderDate, different label.
 * @param {string} text
 * @returns {string|null}
 */
export function parseInvoiceDate(text) {
  if (!text) return null;
  return extractDateAfterLabel(text, 'invoice\\s+date');
}

/**
 * Looks for an "Invoice No./Number/#: <value>" line to pre-fill the
 * Invoice Number field. Returns null if not found — the field is always
 * editable by hand.
 * @param {string} text
 * @returns {string|null}
 */
export function parseInvoiceNumber(text) {
  if (!text) return null;
  const match = text.match(/invoice\s*(?:no\.?|number|#)\s*[:-]?\s*([A-Za-z0-9/-]+)/i);
  return match ? match[1] : null;
}

/**
 * Looks for a stated total to pre-fill Invoices' Amount field — same
 * "prefer the labelled total line, ignore anything unparsable" approach as
 * parseStatedTotal, with invoice-oriented labels ("Grand Total"/"Invoice
 * Amount" over a bare "Total", which is more likely to be a sub-total on a
 * multi-line invoice).
 * @param {string} text
 * @returns {number|null}
 */
export function parseInvoiceAmount(text) {
  if (!text) return null;
  return (
    extractAmountAfterLabel(text, 'grand\\s+total') ??
    extractAmountAfterLabel(text, 'invoice\\s+amount') ??
    extractAmountAfterLabel(text, '\\btotal\\b')
  );
}

// Delivery challans list what was physically delivered — description and
// quantity, no rate (that's an invoice/PO concern, not a delivery record).
// Same "<description> <qty>" or "<description> <qty> <unit-of-measure>"
// shapes as PO line items minus the rate column, and the same
// never-block-on-a-bad-parse philosophy: every matched row still needs to
// be matched against the selected PO's own line items by name before it's
// used for anything (see materialInward.js screen), and quantities stay
// fully editable by hand regardless.
const CHALLAN_LINE_RE = /^(.{2,80}?)\s+(\d+(?:\.\d+)?)\s*$/;
const CHALLAN_LINE_WITH_UOM_RE = /^(.{2,80}?)\s+([\d,]+(?:\.\d+)?)\s+[A-Za-z][A-Za-z.]*\s*$/;

function matchChallanLine(line) {
  if (PHONE_NUMBER_RE.test(line)) return null;
  const simple = line.match(CHALLAN_LINE_RE);
  const match = simple ?? line.match(CHALLAN_LINE_WITH_UOM_RE);
  if (!match) return null;

  const [, rawName, rawQty] = match;
  const itemName = rawName.trim();
  const quantity = toNumber(rawQty);
  if (!itemName || quantity === null || quantity <= 0) return null;
  return { itemName, quantity };
}

/**
 * Heuristic: a line matching "<description> <qty>" (optionally with a
 * unit-of-measure column) becomes one delivered line. Lines that don't
 * match are ignored rather than erroring — a best-effort pass, not a
 * guarantee; every result still needs matching against the selected PO's
 * line items by name (done by the caller), and never blocks logging a
 * receipt by hand.
 * @param {string} text
 * @returns {{ itemName: string, quantity: number }[]}
 */
export function parseChallanText(text) {
  if (!text || !text.trim()) return [];

  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map(matchChallanLine)
    .filter(Boolean);
}
