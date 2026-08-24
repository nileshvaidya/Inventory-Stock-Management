// Pure validation logic — no DOM, no Supabase — cheap to unit test directly.
import { ROLE_VALUES } from './roles.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Phase 0 sign-up: name/email/password only. Role assignment is an Admin
 * action added in Phase 1 (see README.md) — a new account has no role
 * until then.
 * @param {{ name?: string, email?: string, password?: string }} form
 * @returns {{ valid: boolean, errors: Record<string, string> }}
 */
export function validateSignupForm(form) {
  /** @type {Record<string, string>} */
  const errors = {};
  const { name = '', email = '', password = '' } = form || {};

  if (!name.trim()) errors.name = 'Name is required.';
  if (!email.trim()) {
    errors.email = 'Email is required.';
  } else if (!EMAIL_RE.test(email.trim())) {
    errors.email = 'Enter a valid email address.';
  }
  if (!password || password.length < 6) {
    errors.password = 'Password must be at least 6 characters.';
  }

  return { valid: Object.keys(errors).length === 0, errors };
}

/**
 * @param {{ email?: string, password?: string }} form
 */
export function validateSigninForm(form) {
  /** @type {Record<string, string>} */
  const errors = {};
  const { email = '', password = '' } = form || {};
  if (!email.trim()) errors.email = 'Email is required.';
  if (!password) errors.password = 'Password is required.';
  return { valid: Object.keys(errors).length === 0, errors };
}

/**
 * "Add User" (Phase 1) — no password: the new account is created via a
 * real Supabase Auth invite (see supabase/functions/admin-invite-user),
 * not a self-chosen password. Role is optional (an admin can invite
 * someone and assign their role later).
 * @param {{ name?: string, email?: string, role?: string|null }} form
 */
export function validateInviteUserForm(form) {
  /** @type {Record<string, string>} */
  const errors = {};
  const { name = '', email = '', role = null } = form || {};

  if (!name.trim()) errors.name = 'Name is required.';
  if (!email.trim()) {
    errors.email = 'Email is required.';
  } else if (!EMAIL_RE.test(email.trim())) {
    errors.email = 'Enter a valid email address.';
  }
  if (role && !ROLE_VALUES.includes(role)) {
    errors.role = `Invalid role: ${role}`;
  }

  return { valid: Object.keys(errors).length === 0, errors };
}

/**
 * A single PO line item row in the review table (Phase 2).
 * @param {{ itemName?: string, quantity?: string|number, rate?: string|number }} row
 */
export function validateLineItem(row) {
  /** @type {Record<string, string>} */
  const errors = {};
  const { itemName = '', quantity = '', rate = '' } = row || {};

  if (!String(itemName).trim()) errors.itemName = 'Item name is required.';
  const qtyNum = Number(quantity);
  if (quantity === '' || !Number.isFinite(qtyNum) || qtyNum <= 0) {
    errors.quantity = 'Quantity must be a positive number.';
  }
  const rateNum = Number(rate);
  if (rate === '' || !Number.isFinite(rateNum) || rateNum < 0) {
    errors.rate = 'Rate must be zero or a positive number.';
  }

  return { valid: Object.keys(errors).length === 0, errors };
}

/**
 * A single Material Inward "receiving now" row (Phase 3) — receivedQty
 * must be positive and can't exceed what's actually still pending on that
 * line item (client-side guardrail; the DB only guarantees > 0, not this
 * cross-row comparison).
 * @param {{ receivedQty?: string|number, pendingQty?: number }} row
 */
export function validateInwardLineItem(row) {
  /** @type {Record<string, string>} */
  const errors = {};
  const { receivedQty = '', pendingQty = Infinity } = row || {};
  const qtyNum = Number(receivedQty);

  if (receivedQty === '' || !Number.isFinite(qtyNum) || qtyNum <= 0) {
    errors.receivedQty = 'Enter a positive quantity.';
  } else if (qtyNum > pendingQty) {
    errors.receivedQty = `Can't receive more than the pending quantity (${pendingQty}).`;
  }

  return { valid: Object.keys(errors).length === 0, errors };
}

/**
 * The Material Inward form as a whole (Phase 3): a PO, a received date,
 * and at least one line item actually being received this time.
 * @param {{ poId?: string, receivedDate?: string, lineItems?: { receivedQty?: string|number, pendingQty?: number }[] }} form
 */
export function validateInwardForm(form) {
  /** @type {Record<string, string>} */
  const errors = {};
  const { poId = '', receivedDate = '', lineItems = [] } = form || {};

  if (!poId) errors.poId = 'Select a purchase order.';
  if (!receivedDate) errors.receivedDate = 'Received date is required.';

  const enteredRows = lineItems.filter((row) => String(row.receivedQty ?? '').trim() !== '');
  if (enteredRows.length === 0) {
    errors.lineItems = 'Enter a received quantity for at least one item.';
  } else if (enteredRows.some((row) => !validateInwardLineItem(row).valid)) {
    errors.lineItems = 'Fix the highlighted quantity/quantities before saving.';
  }

  return { valid: Object.keys(errors).length === 0, errors };
}

/**
 * An Inspection entry (Phase 3): accepted + rejected must exactly account
 * for the received quantity being inspected — no partial "still pending"
 * remainder in this pass (see src/inspection.js) — and a rejection needs a
 * reason whenever any quantity is rejected (also enforced at the DB layer,
 * this is just so the form catches it before a round trip).
 * @param {{ acceptedQty?: string|number, rejectedQty?: string|number, rejectionReason?: string,
 *   receivedQty?: number }} form
 */
export function validateInspectionForm(form) {
  /** @type {Record<string, string>} */
  const errors = {};
  const { acceptedQty = '', rejectedQty = '', rejectionReason = '', receivedQty = 0 } = form || {};
  const acceptedNum = Number(acceptedQty);
  const rejectedNum = Number(rejectedQty);

  if (acceptedQty === '' || !Number.isFinite(acceptedNum) || acceptedNum < 0) {
    errors.acceptedQty = 'Accepted quantity must be zero or positive.';
  }
  if (rejectedQty === '' || !Number.isFinite(rejectedNum) || rejectedNum < 0) {
    errors.rejectedQty = 'Rejected quantity must be zero or positive.';
  }
  if (!errors.acceptedQty && !errors.rejectedQty) {
    if (acceptedNum + rejectedNum !== Number(receivedQty)) {
      errors.rejectedQty = `Accepted + Rejected must equal the received quantity (${receivedQty}).`;
    } else if (rejectedNum > 0 && !rejectionReason.trim()) {
      errors.rejectionReason = 'A rejection reason is required when any quantity is rejected.';
    }
  }

  return { valid: Object.keys(errors).length === 0, errors };
}

/**
 * The PO Upload form as a whole (Phase 2). At least one valid line item
 * is required — an empty PO isn't useful, and the review table already
 * lets the user add rows by hand when parsing found nothing (P2-6).
 * @param {{ projectId?: string, orderDate?: string, lineItems?: unknown[] }} form
 */
export function validatePurchaseOrderForm(form) {
  /** @type {Record<string, string>} */
  const errors = {};
  const { projectId = '', orderDate = '', lineItems = [] } = form || {};

  if (!projectId) errors.projectId = 'Select or create a Project/Order.';
  if (!orderDate) errors.orderDate = 'Order date is required.';
  if (lineItems.length === 0) {
    errors.lineItems = 'Add at least one line item.';
  } else if (lineItems.some((row) => !validateLineItem(row).valid)) {
    errors.lineItems = 'Fix the highlighted line item(s) before saving.';
  }

  return { valid: Object.keys(errors).length === 0, errors };
}
