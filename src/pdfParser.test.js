import { describe, it, expect } from 'vitest';
import { parsePoText, parseStatedTotal, parsePoNumber, parseOrderDate } from './pdfParser.js';

// A reconstructed-lines rendering of a real Odoo-style Indian PO
// (PO/AISL/2026-27/0032), used to calibrate the real-world line-item and
// total parsing. Numbers/labels match the actual PDF content.
const REAL_PO_TEXT = [
  'Shipping address ASK - warehouse # 2 367, LAXMINARAYAN APT',
  'Purchase Order # PO/AISL/2026-27/0032',
  'Buyer ASK INFO-SOLUTIONS LLP',
  'India  +91 90228 17411',
  'Buyer Order Date: Expected Arrival:',
  'ASK INFO-SOLUTIONS LLP 13/08/2026 14/08/2026',
  'Description Qty Unit Price Disc. Taxes Amount',
  'Base Angle   1,500.00   Nos.   45.00   0.00 %   GST 18%   ₹   67,500.00',
  'Untaxed Amount   ₹   67,500.00',
  'SGST/UTGST   ₹   6,075.00',
  'CGST   ₹   6,075.00',
  'Total   ₹   79,650.00',
  'Delivery Schedule 1500 Nos. 1st Sept 2026',
].join('\n');

describe('parsePoText', () => {
  it('parses clean "item qty rate" lines', () => {
    const rows = parsePoText('Widget A 10 25.50\nWidget B 3 100');
    expect(rows).toEqual([
      { itemName: 'Widget A', quantity: 10, rate: 25.5 },
      { itemName: 'Widget B', quantity: 3, rate: 100 },
    ]);
  });

  it('accepts an x/@/* separator before the rate', () => {
    const rows = parsePoText('Bolt M6 x 20 100 x 2.5');
    expect(rows).toHaveLength(1);
    expect(rows[0].itemName).toBe('Bolt M6 x 20');
    expect(rows[0].quantity).toBe(100);
    expect(rows[0].rate).toBe(2.5);
  });

  it('ignores lines that do not match the item/qty/rate shape', () => {
    const rows = parsePoText('Purchase Order #1234\nDate: 2026-01-01\nThank you for your business');
    expect(rows).toEqual([]);
  });

  it('returns an empty array for empty or whitespace-only text (P2-6)', () => {
    expect(parsePoText('')).toEqual([]);
    expect(parsePoText('   \n  \n ')).toEqual([]);
  });

  it('rejects a row with zero or negative quantity', () => {
    const rows = parsePoText('Widget 0 10\nGadget -5 10');
    expect(rows).toEqual([]);
  });

  it('parses a real PO line with comma-formatted qty and a unit-of-measure column, ignoring trailing discount/tax/amount columns', () => {
    const rows = parsePoText(REAL_PO_TEXT);
    expect(rows).toEqual([{ itemName: 'Base Angle', quantity: 1500, rate: 45 }]);
  });

  it('does not mistake a phone number ("+91 90228 17411") for a line item', () => {
    expect(parsePoText('India  +91 90228 17411')).toEqual([]);
  });

  it('does not mistake header, metadata, or totals lines for line items', () => {
    const noise = [
      'Purchase Order # PO/AISL/2026-27/0032',
      'Order Date: 13/08/2026',
      'Description Qty Unit Price Disc. Taxes Amount',
      'Untaxed Amount   ₹   67,500.00',
      'Total   ₹   79,650.00',
    ].join('\n');
    expect(parsePoText(noise)).toEqual([]);
  });
});

describe('parseStatedTotal', () => {
  it('finds a "Total: <amount>" line', () => {
    expect(parseStatedTotal('Item 1 2 3\nTotal: 1234.50')).toBe(1234.5);
  });

  it('finds a "Grand Total <amount>" line with thousands separators', () => {
    expect(parseStatedTotal('Grand Total 12,345.00')).toBe(12345);
  });

  it('returns null when no total line is present', () => {
    expect(parseStatedTotal('Widget A 10 25.50')).toBe(null);
  });

  it('returns null for empty text', () => {
    expect(parseStatedTotal('')).toBe(null);
  });

  it('prefers "Untaxed Amount" (pre-tax) over "Total" (tax-inclusive) and handles the ₹ symbol', () => {
    expect(parseStatedTotal(REAL_PO_TEXT)).toBe(67500);
  });

  it('falls back to "Total" with a ₹ symbol when there is no "Untaxed Amount" line', () => {
    expect(parseStatedTotal('Item 1 2 3\nTotal   ₹   79,650.00')).toBe(79650);
  });
});

describe('parsePoNumber', () => {
  it('finds a "Purchase Order # <number>" line', () => {
    expect(parsePoNumber(REAL_PO_TEXT)).toBe('PO/AISL/2026-27/0032');
  });

  it('returns null when no PO number line is present', () => {
    expect(parsePoNumber('Widget A 10 25.50')).toBe(null);
  });

  it('returns null for empty text', () => {
    expect(parsePoNumber('')).toBe(null);
  });
});

describe('parseOrderDate', () => {
  it('finds an "Order Date: DD/MM/YYYY" line and converts to ISO', () => {
    expect(parseOrderDate('Order Date: 13/08/2026')).toBe('2026-08-13');
  });

  it('finds the date when "Order Date:" and its value are on different reconstructed lines (multi-column layout)', () => {
    expect(parseOrderDate(REAL_PO_TEXT)).toBe('2026-08-13');
  });

  it('returns null when no order date line is present', () => {
    expect(parseOrderDate('Widget A 10 25.50')).toBe(null);
  });

  it('returns null for empty text', () => {
    expect(parseOrderDate('')).toBe(null);
  });
});
