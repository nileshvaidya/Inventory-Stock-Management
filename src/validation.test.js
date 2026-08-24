import { describe, it, expect } from 'vitest';
import {
  validateSignupForm,
  validateSigninForm,
  validateInviteUserForm,
  validateLineItem,
  validatePurchaseOrderForm,
  validateInwardLineItem,
  validateInwardForm,
  validateInspectionForm,
  validateItemForm,
  validateStockMovementForm,
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

describe('validateInwardLineItem', () => {
  it('accepts a positive quantity within the pending amount', () => {
    expect(validateInwardLineItem({ receivedQty: 50, pendingQty: 100 }).valid).toBe(true);
  });

  it('accepts receiving exactly the pending amount', () => {
    expect(validateInwardLineItem({ receivedQty: 100, pendingQty: 100 }).valid).toBe(true);
  });

  it('rejects zero, negative, or non-numeric quantity', () => {
    expect(validateInwardLineItem({ receivedQty: 0, pendingQty: 100 }).valid).toBe(false);
    expect(validateInwardLineItem({ receivedQty: -5, pendingQty: 100 }).valid).toBe(false);
    expect(validateInwardLineItem({ receivedQty: 'abc', pendingQty: 100 }).valid).toBe(false);
  });

  it('rejects a quantity greater than what is pending', () => {
    const { valid, errors } = validateInwardLineItem({ receivedQty: 150, pendingQty: 100 });
    expect(valid).toBe(false);
    expect(errors.receivedQty).toBeTruthy();
  });
});

describe('validateInwardForm', () => {
  it('accepts a valid form with one entered line item', () => {
    const { valid } = validateInwardForm({
      poId: 'po-1',
      receivedDate: '2026-01-01',
      lineItems: [{ receivedQty: 10, pendingQty: 100 }],
    });
    expect(valid).toBe(true);
  });

  it('rejects a missing PO or received date', () => {
    expect(validateInwardForm({ receivedDate: '2026-01-01', lineItems: [{ receivedQty: 10, pendingQty: 100 }] }).valid).toBe(
      false
    );
    expect(validateInwardForm({ poId: 'po-1', lineItems: [{ receivedQty: 10, pendingQty: 100 }] }).valid).toBe(false);
  });

  it('rejects a form with no quantity entered on any line item', () => {
    const { valid, errors } = validateInwardForm({
      poId: 'po-1',
      receivedDate: '2026-01-01',
      lineItems: [{ receivedQty: '', pendingQty: 100 }],
    });
    expect(valid).toBe(false);
    expect(errors.lineItems).toBeTruthy();
  });

  it('rejects a form where an entered quantity exceeds pending', () => {
    const { valid } = validateInwardForm({
      poId: 'po-1',
      receivedDate: '2026-01-01',
      lineItems: [{ receivedQty: 999, pendingQty: 100 }],
    });
    expect(valid).toBe(false);
  });
});

describe('validateInspectionForm', () => {
  it('accepts accepted+rejected exactly equal to received qty', () => {
    expect(validateInspectionForm({ acceptedQty: 8, rejectedQty: 2, rejectionReason: 'Damaged', receivedQty: 10 }).valid).toBe(
      true
    );
  });

  it('accepts a fully accepted inspection with no rejection reason needed', () => {
    expect(validateInspectionForm({ acceptedQty: 10, rejectedQty: 0, rejectionReason: '', receivedQty: 10 }).valid).toBe(true);
  });

  it('rejects negative or non-numeric quantities', () => {
    expect(validateInspectionForm({ acceptedQty: -1, rejectedQty: 0, receivedQty: 10 }).valid).toBe(false);
    expect(validateInspectionForm({ acceptedQty: 10, rejectedQty: 'abc', receivedQty: 10 }).valid).toBe(false);
  });

  it("rejects accepted+rejected that doesn't add up to the received quantity", () => {
    const { valid, errors } = validateInspectionForm({ acceptedQty: 5, rejectedQty: 2, rejectionReason: 'x', receivedQty: 10 });
    expect(valid).toBe(false);
    expect(errors.rejectedQty).toBeTruthy();
  });

  it('requires a rejection reason whenever any quantity is rejected', () => {
    const { valid, errors } = validateInspectionForm({ acceptedQty: 8, rejectedQty: 2, rejectionReason: '', receivedQty: 10 });
    expect(valid).toBe(false);
    expect(errors.rejectionReason).toBeTruthy();
  });
});

describe('validateItemForm', () => {
  it('accepts a name-only form (everything else optional)', () => {
    expect(validateItemForm({ name: 'Base Angle' }).valid).toBe(true);
  });

  it('accepts a valid reorder level', () => {
    expect(validateItemForm({ name: 'Base Angle', reorderLevel: 50 }).valid).toBe(true);
  });

  it('rejects a missing name', () => {
    const { valid, errors } = validateItemForm({ name: '' });
    expect(valid).toBe(false);
    expect(errors.name).toBeTruthy();
  });

  it('rejects a negative or non-numeric reorder level', () => {
    expect(validateItemForm({ name: 'Base Angle', reorderLevel: -5 }).valid).toBe(false);
    expect(validateItemForm({ name: 'Base Angle', reorderLevel: 'abc' }).valid).toBe(false);
  });

  it('treats an empty reorder level as unset, not invalid', () => {
    expect(validateItemForm({ name: 'Base Angle', reorderLevel: '' }).valid).toBe(true);
  });
});

describe('validateStockMovementForm', () => {
  it('accepts a valid In movement', () => {
    expect(validateStockMovementForm({ itemId: 'item-1', movementType: 'in', quantity: 10 }).valid).toBe(true);
  });

  it('accepts a valid Out movement', () => {
    expect(validateStockMovementForm({ itemId: 'item-1', movementType: 'out', quantity: 5 }).valid).toBe(true);
  });

  it('rejects a missing item', () => {
    const { valid, errors } = validateStockMovementForm({ movementType: 'in', quantity: 10 });
    expect(valid).toBe(false);
    expect(errors.itemId).toBeTruthy();
  });

  it('rejects an invalid movement type', () => {
    const { valid, errors } = validateStockMovementForm({ itemId: 'item-1', movementType: 'adjustment', quantity: 10 });
    expect(valid).toBe(false);
    expect(errors.movementType).toBeTruthy();
  });

  it('rejects a zero, negative, or non-numeric quantity', () => {
    expect(validateStockMovementForm({ itemId: 'item-1', movementType: 'in', quantity: 0 }).valid).toBe(false);
    expect(validateStockMovementForm({ itemId: 'item-1', movementType: 'in', quantity: -5 }).valid).toBe(false);
    expect(validateStockMovementForm({ itemId: 'item-1', movementType: 'in', quantity: 'abc' }).valid).toBe(false);
  });
});
