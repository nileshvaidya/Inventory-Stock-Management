// Manual field-mapping fallback for imported documents, for when the
// built-in heuristics (src/pdfParser.js's regexes, today) don't recognize
// a vendor's layout. Nothing here is PO-specific: it operates on plain
// text lines and token positions, so the same functions serve invoices,
// delivery challans, and payment receipts once those phases exist — only
// the UI that calls this (src/screens/poUpload.js) and the field labels
// shown to the user are PO-specific right now.
//
// The core idea is a "recorded macro", not a layout-detection model: a
// user manually maps ONE example row (which token(s) are the item name,
// which token is qty, which is rate) and that becomes a reusable column
// template — position-based, keyed per vendor (src/importMappings.js) —
// applied to future lines from the same vendor. This is deliberately
// simple: a template only matches lines with the exact same token count as
// the example row, which keeps false positives low without needing to
// infer anything about the layout beyond what the user actually pointed at.

/**
 * Splits a line of extracted text into whitespace-separated tokens, each
 * tagged with its position — the position is what both the click-to-assign
 * UI and the saved column template key off of.
 * @param {string} line
 * @returns {{ text: string, index: number }[]}
 */
export function tokenizeLine(line) {
  return (line ?? '')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((text, index) => ({ text, index }));
}

/**
 * @param {string} raw
 * @returns {number|null}
 */
export function parseNumberToken(raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  const value = Number(String(raw).replace(/,/g, ''));
  return Number.isFinite(value) ? value : null;
}

/**
 * @param {{ tokenCount: number, itemNameTokenIndices: number[], qtyTokenIndex: number, rateTokenIndex: number }} example
 * @returns {{ tokenCount: number, itemNameTokenIndices: number[], qtyTokenIndex: number, rateTokenIndex: number }}
 */
export function deriveColumnTemplate({ tokenCount, itemNameTokenIndices, qtyTokenIndex, rateTokenIndex }) {
  return {
    tokenCount,
    itemNameTokenIndices: [...itemNameTokenIndices].sort((a, b) => a - b),
    qtyTokenIndex,
    rateTokenIndex,
  };
}

/**
 * Applies a saved column template to a fresh document's raw lines. Returns
 * the same `{ itemName, quantity, rate }[]` shape as pdfParser's
 * parsePoText, so callers can use either strategy's output interchangeably.
 * Lines whose token count doesn't match the template, or whose designated
 * qty/rate tokens aren't numeric, are silently skipped — same "best
 * effort, never blocks" principle as the regex-based parser: every
 * resulting row is still editable/deletable in the review table.
 * @param {string[]} lines
 * @param {{ tokenCount: number, itemNameTokenIndices: number[], qtyTokenIndex: number, rateTokenIndex: number }|null|undefined} template
 * @returns {{ itemName: string, quantity: number, rate: number }[]}
 */
export function applyColumnTemplate(lines, template) {
  if (!template) return [];
  const { tokenCount, itemNameTokenIndices, qtyTokenIndex, rateTokenIndex } = template;

  const rows = [];
  for (const line of lines ?? []) {
    const tokens = tokenizeLine(line);
    if (tokens.length !== tokenCount) continue;

    const itemName = itemNameTokenIndices
      .map((i) => tokens[i]?.text ?? '')
      .join(' ')
      .trim();
    const quantity = parseNumberToken(tokens[qtyTokenIndex]?.text);
    const rate = parseNumberToken(tokens[rateTokenIndex]?.text);
    if (!itemName || quantity === null || quantity <= 0 || rate === null || rate < 0) continue;

    rows.push({ itemName, quantity, rate });
  }
  return rows;
}
