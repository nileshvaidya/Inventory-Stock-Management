// PO PDF parsing (Phase 2). Two parts, deliberately separate:
//   - extractPdfText(): pdf.js text extraction from a File — impure, needs
//     a real PDF, not unit-testable without a binary fixture.
//   - parsePoText(): pure regex heuristic over the extracted text —
//     unit-testable directly, no PDF involved.
// There's no real PO template to calibrate the heuristic against yet (see
// README.md's Phase 2 open items) — it's a best-effort first pass. Every
// row it produces is editable/deletable in the review step, and rows can
// be added by hand, so a bad or empty parse never blocks creating a PO.
import * as pdfjsLib from 'pdfjs-dist';
import pdfjsWorker from 'pdfjs-dist/build/pdf.worker.mjs?url';

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsWorker;

/**
 * @param {File} file
 * @returns {Promise<string>} raw extracted text, empty string if the PDF
 *   has no extractable text layer (e.g. a scanned image with no OCR) —
 *   never throws for that case, only for a file that isn't a readable PDF
 *   at all (P2-6: malformed PDF).
 */
export async function extractPdfText(file) {
  const buffer = await file.arrayBuffer();
  const doc = await pdfjsLib.getDocument({ data: buffer }).promise;
  const pageTexts = [];
  for (let pageNum = 1; pageNum <= doc.numPages; pageNum += 1) {
    const page = await doc.getPage(pageNum);
    const content = await page.getTextContent();
    pageTexts.push(content.items.map((item) => ('str' in item ? item.str : '')).join(' '));
  }
  return pageTexts.join('\n');
}

// Quantity and rate must be separated by at least one real whitespace
// character (the optional x/@/* marker sits inside that whitespace, never
// replaces it) — without a mandatory \s+ here, greedy backtracking can
// satisfy the pattern by splitting a single number like "10" into "1" and
// "0" with zero characters between them, which is nonsense, not a parse.
const LINE_ITEM_RE = /^(.{2,80}?)\s+(\d+(?:\.\d+)?)\s+(?:[x@*]\s*)?(\d+(?:\.\d+)?)\s*$/;

/**
 * Heuristic: a line matching "<description> <qty> <rate>" (optionally
 * with an x/@/* separator before the rate, e.g. "Widget 10 x 25.50")
 * becomes one line item. Lines that don't match are ignored rather than
 * erroring — this is a best-effort first pass, not a guarantee.
 * @param {string} text
 * @returns {{ itemName: string, quantity: number, rate: number }[]}
 */
export function parsePoText(text) {
  if (!text || !text.trim()) return [];

  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = line.match(LINE_ITEM_RE);
      if (!match) return null;
      const [, rawName, rawQty, rawRate] = match;
      const itemName = rawName.trim();
      const quantity = Number(rawQty);
      const rate = Number(rawRate);
      if (!itemName || !Number.isFinite(quantity) || quantity <= 0 || !Number.isFinite(rate) || rate < 0) {
        return null;
      }
      return { itemName, quantity, rate };
    })
    .filter(Boolean);
}

/**
 * Looks for a line like "Total: 1234.50" / "Grand Total 1,234.50" to
 * cross-check against the sum of parsed line items (P2-7). Returns null
 * if no such line is found — the totals check is then simply skipped
 * rather than treated as a mismatch.
 * @param {string} text
 * @returns {number|null}
 */
export function parseStatedTotal(text) {
  if (!text) return null;
  const match = text.match(/(?:grand\s+)?total[:\s]+([\d,]+(?:\.\d+)?)/i);
  if (!match) return null;
  const value = Number(match[1].replace(/,/g, ''));
  return Number.isFinite(value) ? value : null;
}
