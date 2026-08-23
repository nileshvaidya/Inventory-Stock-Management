import { describe, it, expect } from 'vitest';
import { toCsv } from './csvExport.js';

describe('toCsv', () => {
  const columns = [
    { key: 'name', header: 'Name' },
    { key: 'qty', header: 'Qty' },
  ];

  it('builds a header row plus one row per input object', () => {
    const csv = toCsv([{ name: 'Widget', qty: 5 }], columns);
    expect(csv).toBe('Name,Qty\r\nWidget,5');
  });

  it('quotes a value containing a comma, quote, or newline', () => {
    const csv = toCsv([{ name: 'Widget, Deluxe', qty: 1 }], columns);
    expect(csv).toBe('Name,Qty\r\n"Widget, Deluxe",1');
  });

  it('escapes an embedded double quote by doubling it', () => {
    const csv = toCsv([{ name: 'The "Big" Widget', qty: 1 }], columns);
    expect(csv).toBe('Name,Qty\r\n"The ""Big"" Widget",1');
  });

  it('renders null/undefined as an empty cell', () => {
    const csv = toCsv([{ name: null, qty: undefined }], columns);
    expect(csv).toBe('Name,Qty\r\n,');
  });

  it('produces just the header row for an empty dataset', () => {
    expect(toCsv([], columns)).toBe('Name,Qty');
  });
});
