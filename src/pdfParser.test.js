import { describe, it, expect } from 'vitest';
import { parsePoText, parseStatedTotal } from './pdfParser.js';

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
});
