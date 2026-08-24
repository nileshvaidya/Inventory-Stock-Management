import { describe, it, expect } from 'vitest';
import { tokenizeLine, parseNumberToken, deriveColumnTemplate, applyColumnTemplate } from './docMapping.js';

describe('tokenizeLine', () => {
  it('splits on whitespace and tags each token with its position', () => {
    expect(tokenizeLine('Base Angle 1,500.00 Nos. 45.00')).toEqual([
      { text: 'Base', index: 0 },
      { text: 'Angle', index: 1 },
      { text: '1,500.00', index: 2 },
      { text: 'Nos.', index: 3 },
      { text: '45.00', index: 4 },
    ]);
  });

  it('collapses repeated whitespace and trims', () => {
    expect(tokenizeLine('  A   B  ')).toEqual([
      { text: 'A', index: 0 },
      { text: 'B', index: 1 },
    ]);
  });

  it('returns an empty array for empty/whitespace-only input', () => {
    expect(tokenizeLine('')).toEqual([]);
    expect(tokenizeLine('   ')).toEqual([]);
    expect(tokenizeLine(undefined)).toEqual([]);
  });
});

describe('parseNumberToken', () => {
  it('parses a plain number', () => {
    expect(parseNumberToken('45')).toBe(45);
  });

  it('strips comma thousands separators', () => {
    expect(parseNumberToken('1,500.00')).toBe(1500);
  });

  it('returns null for non-numeric input', () => {
    expect(parseNumberToken('Nos.')).toBe(null);
  });

  it('returns null for empty/undefined input', () => {
    expect(parseNumberToken('')).toBe(null);
    expect(parseNumberToken(undefined)).toBe(null);
  });
});

describe('deriveColumnTemplate', () => {
  it('captures token positions and sorts item-name indices', () => {
    const template = deriveColumnTemplate({
      tokenCount: 5,
      itemNameTokenIndices: [1, 0],
      qtyTokenIndex: 2,
      rateTokenIndex: 4,
    });
    expect(template).toEqual({ tokenCount: 5, itemNameTokenIndices: [0, 1], qtyTokenIndex: 2, rateTokenIndex: 4 });
  });
});

describe('applyColumnTemplate', () => {
  const template = deriveColumnTemplate({
    tokenCount: 5,
    itemNameTokenIndices: [0, 1],
    qtyTokenIndex: 2,
    rateTokenIndex: 4,
  });

  it('applies a saved template to matching lines', () => {
    const rows = applyColumnTemplate(
      ['Base Angle 1,500.00 Nos. 45.00', 'Steel Rod 200.00 Kg 12.50'],
      template
    );
    expect(rows).toEqual([
      { itemName: 'Base Angle', quantity: 1500, rate: 45 },
      { itemName: 'Steel Rod', quantity: 200, rate: 12.5 },
    ]);
  });

  it('skips lines whose token count does not match the template', () => {
    const rows = applyColumnTemplate(['Purchase Order # PO/AISL/2026-27/0032'], template);
    expect(rows).toEqual([]);
  });

  it('skips lines whose designated qty/rate tokens are not numeric (matching token count, non-numeric content)', () => {
    const rows = applyColumnTemplate(['Item One Two Three Four'], template);
    expect(rows).toEqual([]);
  });

  it('rejects zero quantity or negative rate', () => {
    const rows = applyColumnTemplate(['Widget A 0 x -5'], template);
    expect(rows).toEqual([]);
  });

  it('returns an empty array when no template is saved', () => {
    expect(applyColumnTemplate(['Base Angle 1,500.00 Nos. 45.00'], null)).toEqual([]);
    expect(applyColumnTemplate(['Base Angle 1,500.00 Nos. 45.00'], undefined)).toEqual([]);
  });

  it('returns an empty array for no lines', () => {
    expect(applyColumnTemplate([], template)).toEqual([]);
    expect(applyColumnTemplate(undefined, template)).toEqual([]);
  });
});
