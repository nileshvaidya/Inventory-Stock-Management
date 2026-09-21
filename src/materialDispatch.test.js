import { describe, it, expect } from 'vitest';
import { dispatchTotalAmount, dispatchFinalAmount } from './materialDispatch.js';

describe('dispatchTotalAmount', () => {
  it('sums quantity x rate across line items', () => {
    const dispatch = {
      line_items: [
        { quantity: 5, rate: 10 },
        { quantity: 2, rate: 25 },
      ],
    };
    expect(dispatchTotalAmount(dispatch)).toBe(100);
  });

  it('treats a missing rate as zero, and no line items as zero', () => {
    expect(dispatchTotalAmount({ line_items: [{ quantity: 5, rate: null }] })).toBe(0);
    expect(dispatchTotalAmount({ line_items: [] })).toBe(0);
    expect(dispatchTotalAmount({})).toBe(0);
  });
});

describe('dispatchFinalAmount', () => {
  it('adds GST on top of the total amount', () => {
    const dispatch = { line_items: [{ quantity: 10, rate: 10 }], gst_percent: 18 };
    expect(dispatchFinalAmount(dispatch)).toBeCloseTo(118, 5);
  });

  it('treats a missing/null gst_percent as 0% — Final Amount equals Total Amount', () => {
    const dispatch = { line_items: [{ quantity: 10, rate: 10 }], gst_percent: null };
    expect(dispatchFinalAmount(dispatch)).toBe(100);
    expect(dispatchFinalAmount({ line_items: [{ quantity: 10, rate: 10 }] })).toBe(100);
  });

  it('accepts a 0% GST rate explicitly', () => {
    const dispatch = { line_items: [{ quantity: 10, rate: 10 }], gst_percent: 0 };
    expect(dispatchFinalAmount(dispatch)).toBe(100);
  });
});
