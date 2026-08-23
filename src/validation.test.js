import { describe, it, expect } from 'vitest';
import {
  validateSignupForm,
  validateSigninForm,
  validateInviteUserForm,
  validateLineItem,
  validatePurchaseOrderForm,
} from './validation.js';

describe('validateSignupForm', () => {
  it('accepts a valid form', () => {
    const { valid } = validateSignupForm({ name: 'Jane Doe', email: 'jane@example.com', password: 'secret1' });
    expect(valid).toBe(true);
  });

  it('rejects a missing name', () => {
    const { valid, errors } = validateSignupForm({ name: '', email: 'jane@example.com', password: 'secret1' });
    expect(valid).toBe(false);
    expect(errors.name).toBeTruthy();
  });

  it('rejects an invalid email', () => {
    const { valid, errors } = validateSignupForm({ name: 'Jane', email: 'not-an-email', password: 'secret1' });
    expect(valid).toBe(false);
    expect(errors.email).toBeTruthy();
  });

  it('rejects a short password', () => {
    const { valid, errors } = validateSignupForm({ name: 'Jane', email: 'jane@example.com', password: 'abc' });
    expect(valid).toBe(false);
    expect(errors.password).toBeTruthy();
  });
});

describe('validateSigninForm', () => {
  it('accepts a valid form', () => {
    const { valid } = validateSigninForm({ email: 'jane@example.com', password: 'secret1' });
    expect(valid).toBe(true);
  });

  it('rejects missing fields', () => {
    const { valid, errors } = validateSigninForm({ email: '', password: '' });
    expect(valid).toBe(false);
    expect(errors.email).toBeTruthy();
    expect(errors.password).toBeTruthy();
  });
});

describe('validateInviteUserForm', () => {
  it('accepts a valid form with a role', () => {
    const { valid } = validateInviteUserForm({ name: 'Jane Doe', email: 'jane@example.com', role: 'store' });
    expect(valid).toBe(true);
  });

  it('accepts a valid form with no role (assigned later)', () => {
    const { valid } = validateInviteUserForm({ name: 'Jane Doe', email: 'jane@example.com', role: null });
    expect(valid).toBe(true);
  });

  it('rejects a missing name or invalid email', () => {
    expect(validateInviteUserForm({ name: '', email: 'jane@example.com' }).valid).toBe(false);
    expect(validateInviteUserForm({ name: 'Jane', email: 'not-an-email' }).valid).toBe(false);
  });

  it('rejects a role not in the confirmed list', () => {
    const { valid, errors } = validateInviteUserForm({ name: 'Jane', email: 'jane@example.com', role: 'manager' });
    expect(valid).toBe(false);
    expect(errors.role).toBeTruthy();
  });
});

describe('validateLineItem', () => {
  it('accepts a valid row', () => {
    expect(validateLineItem({ itemName: 'Widget', quantity: 10, rate: 25.5 }).valid).toBe(true);
  });

  it('accepts a zero rate (free item) but not a zero quantity', () => {
    expect(validateLineItem({ itemName: 'Widget', quantity: 10, rate: 0 }).valid).toBe(true);
    expect(validateLineItem({ itemName: 'Widget', quantity: 0, rate: 10 }).valid).toBe(false);
  });

  it('rejects a missing item name', () => {
    const { valid, errors } = validateLineItem({ itemName: '', quantity: 10, rate: 5 });
    expect(valid).toBe(false);
    expect(errors.itemName).toBeTruthy();
  });

  it('rejects a negative rate or non-numeric quantity', () => {
    expect(validateLineItem({ itemName: 'Widget', quantity: 10, rate: -1 }).valid).toBe(false);
    expect(validateLineItem({ itemName: 'Widget', quantity: 'abc', rate: 5 }).valid).toBe(false);
  });
});

describe('validatePurchaseOrderForm', () => {
  const validLineItems = [{ itemName: 'Widget', quantity: 10, rate: 5 }];

  it('accepts a valid form', () => {
    const { valid } = validatePurchaseOrderForm({ projectId: 'p1', orderDate: '2026-01-01', lineItems: validLineItems });
    expect(valid).toBe(true);
  });

  it('rejects a missing project or order date', () => {
    expect(validatePurchaseOrderForm({ orderDate: '2026-01-01', lineItems: validLineItems }).valid).toBe(false);
    expect(validatePurchaseOrderForm({ projectId: 'p1', lineItems: validLineItems }).valid).toBe(false);
  });

  it('rejects an empty line item list', () => {
    const { valid, errors } = validatePurchaseOrderForm({ projectId: 'p1', orderDate: '2026-01-01', lineItems: [] });
    expect(valid).toBe(false);
    expect(errors.lineItems).toBeTruthy();
  });

  it('rejects a form with an invalid line item row', () => {
    const { valid } = validatePurchaseOrderForm({
      projectId: 'p1',
      orderDate: '2026-01-01',
      lineItems: [{ itemName: '', quantity: 10, rate: 5 }],
    });
    expect(valid).toBe(false);
  });
});
