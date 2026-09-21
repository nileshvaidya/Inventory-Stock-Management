// Delivery Challans (Phase 13, direct request): the admin-only billing
// view over Material Dispatch's own data — see materialDispatch.js/
// deliveryChallans.js for why payment tracking and PO/invoice editing
// live here rather than on Material Dispatch itself. Network-mocked
// against demo mode, same approach as every other phase spec. Real
// RLS/RPC enforcement (admin-only insert of client_po_number,
// admin_update_dispatch_billing, mark_dispatch_payment_received's new
// payment_date_in argument) is covered by
// scripts/test-rls-material-dispatch.mjs against a real database.
import { test, expect } from '@playwright/test';

const DISPATCH_UNAUTHORIZED = {
  id: 'dispatch-1',
  dispatch_date: '2026-01-15',
  dc_number: 'DC-1001',
  reference: 'Acme Corp',
  notes: null,
  client_po_number: null,
  our_invoice_number: null,
  gst_percent: 18,
  challan_file_path: null,
  challan_file_name: null,
  authorized_by: null,
  authorized_at: null,
  payment_received_by: null,
  payment_received_at: null,
  payment_date: null,
  line_items: [{ id: 'li-1', item_id: 'item-widget', quantity: 5, rate: 25, item: { id: 'item-widget', name: 'Widget', unit_of_measure: 'Nos.' } }],
};

const DISPATCH_AUTHORIZED = {
  ...DISPATCH_UNAUTHORIZED,
  id: 'dispatch-2',
  dc_number: 'DC-1002',
  client_po_number: 'PO-CLIENT-9',
  our_invoice_number: 'INV-500',
  authorized_by: 'admin-1',
  authorized_at: '2026-01-16T00:00:00Z',
  line_items: [
    { id: 'li-2', item_id: 'item-widget', quantity: 3, rate: 40, item: { id: 'item-widget', name: 'Widget', unit_of_measure: 'Nos.' } },
    { id: 'li-3', item_id: 'item-gizmo', quantity: 2, rate: 10, item: { id: 'item-gizmo', name: 'Gizmo', unit_of_measure: 'Nos.' } },
  ],
};

function mockDispatches(page, dispatches) {
  return page.route('**/rest/v1/material_dispatch**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(dispatches) })
  );
}

test.describe('Delivery Challans — route guard', () => {
  test('a non-admin navigating directly to #/delivery-challans is redirected to the dashboard', async ({ page }) => {
    await page.goto('/?demoRole=store#/delivery-challans');
    await expect(page).toHaveURL(/#\/dashboard$/);
  });

  test('the sidebar link only appears for admin', async ({ page }) => {
    await page.goto('/?demoRole=store#/dashboard');
    await expect(page.locator('[data-nav="/delivery-challans"]')).toHaveCount(0);

    await page.goto('/?demoRole=admin#/dashboard');
    await expect(page.locator('[data-nav="/delivery-challans"]').first()).toBeVisible();
  });
});

test.describe('Delivery Challans — list', () => {
  test('shows DC No., date, party, PO No., invoice #, total amount, and status', async ({ page }) => {
    await mockDispatches(page, [DISPATCH_UNAUTHORIZED, DISPATCH_AUTHORIZED]);

    await page.goto('/?demoRole=admin#/delivery-challans');
    await expect(page.locator('[data-screen="delivery-challans"]')).toBeVisible();

    const pendingRow = page.locator('[data-challan-row="dispatch-1"]');
    await expect(pendingRow).toContainText('DC-1001');
    await expect(pendingRow).toContainText('2026-01-15');
    await expect(pendingRow).toContainText('Acme Corp');
    await expect(pendingRow).toContainText('125.00'); // 5 * 25
    await expect(pendingRow).toContainText('Pending Authorization');

    const authorizedRow = page.locator('[data-challan-row="dispatch-2"]');
    await expect(authorizedRow).toContainText('DC-1002');
    await expect(authorizedRow).toContainText('PO-CLIENT-9');
    await expect(authorizedRow).toContainText('INV-500');
    await expect(authorizedRow).toContainText('140.00'); // 3*40 + 2*10
  });

  test('clicking Details shows the item/quantity/rate/amount breakdown', async ({ page }) => {
    await mockDispatches(page, [DISPATCH_AUTHORIZED]);

    await page.goto('/?demoRole=admin#/delivery-challans');
    await page.click('[data-challan-row="dispatch-2"] [data-action="toggle-challan"]');

    const detail = page.locator('[data-challan-detail-row="dispatch-2"]');
    await expect(detail).toContainText('Widget');
    await expect(detail).toContainText('Gizmo');
    await expect(detail).toContainText('120.00'); // Widget: 3 * 40
    await expect(detail).toContainText('20.00'); // Gizmo: 2 * 10
    await expect(detail).toContainText('140.00'); // total
  });
});

test.describe('Delivery Challans — Final Amount (Total Amount with GST) and Pending Dues', () => {
  test('Final Amount column includes GST, and the detail breakdown shows GST + Final Amount', async ({ page }) => {
    await mockDispatches(page, [DISPATCH_AUTHORIZED]);

    await page.goto('/?demoRole=admin#/delivery-challans');
    const row = page.locator('[data-challan-row="dispatch-2"]');
    // Total 140 x 1.18 = 165.20
    await expect(row.locator('[data-role="challan-final-amount"]')).toContainText('165.20');

    await page.click('[data-challan-row="dispatch-2"] [data-action="toggle-challan"]');
    const detail = page.locator('[data-challan-detail-row="dispatch-2"]');
    await expect(detail).toContainText('GST (18%)');
    await expect(detail).toContainText('25.20'); // GST amount: 140 * 0.18
    await expect(detail).toContainText('Final Amount');
    await expect(detail).toContainText('165.20');
  });

  test('Pending Dues sums Final Amount only across authorized-but-unpaid challans', async ({ page }) => {
    // dispatch-1 is unauthorized (excluded), dispatch-2 is authorized/unpaid
    // (included, 165.20), a third authorized-but-already-paid dispatch is
    // also excluded.
    const PAID = { ...DISPATCH_AUTHORIZED, id: 'dispatch-3', dc_number: 'DC-1003', payment_received_at: '2026-02-01T00:00:00Z', payment_date: '2026-01-31' };
    await mockDispatches(page, [DISPATCH_UNAUTHORIZED, DISPATCH_AUTHORIZED, PAID]);

    await page.goto('/?demoRole=admin#/delivery-challans');
    await expect(page.locator('[data-role="pending-dues"]')).toContainText('165.20');
  });

  test('marking a challan Paid deducts its Final Amount from Pending Dues', async ({ page }) => {
    let requestCount = 0;
    await page.route('**/rest/v1/material_dispatch**', (route) => {
      requestCount += 1;
      const body = requestCount === 1 ? DISPATCH_AUTHORIZED : { ...DISPATCH_AUTHORIZED, payment_received_at: '2026-02-01T00:00:00Z', payment_date: '2026-01-31' };
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([body]) });
    });
    await page.route('**/rest/v1/rpc/mark_dispatch_payment_received**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));

    await page.goto('/?demoRole=admin#/delivery-challans');
    await expect(page.locator('[data-role="pending-dues"]')).toContainText('165.20');

    const row = page.locator('[data-challan-row="dispatch-2"]');
    await row.locator('[data-action="status-select"]').selectOption('paid');
    await row.locator('[data-action="payment-date"]').fill('2026-01-31');
    await row.locator('[data-action="payment-date"]').blur();
    await row.locator('[data-action="save-payment"]').click();

    await expect(page.locator('[data-role="pending-dues"]')).toContainText('0.00');
  });
});

test.describe('Delivery Challans — editing PO No. / Our Invoice #', () => {
  test('admin edits PO No. and Our Invoice #, saving via admin_update_dispatch_billing', async ({ page }) => {
    let requestCount = 0;
    await page.route('**/rest/v1/material_dispatch**', (route) => {
      requestCount += 1;
      const body = requestCount === 1 ? DISPATCH_UNAUTHORIZED : { ...DISPATCH_UNAUTHORIZED, client_po_number: 'PO-NEW', our_invoice_number: 'INV-NEW' };
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([body]) });
    });
    let billingBody = null;
    await page.route('**/rest/v1/rpc/admin_update_dispatch_billing**', (route) => {
      billingBody = route.request().postDataJSON();
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    });

    await page.goto('/?demoRole=admin#/delivery-challans');
    await page.click('[data-challan-row="dispatch-1"] [data-action="toggle-challan"]');
    await page.click('[data-action="edit-billing"][data-id="dispatch-1"]');

    await page.fill('[data-action="billing-po"][data-id="dispatch-1"]', 'PO-NEW');
    await page.fill('[data-action="billing-invoice"][data-id="dispatch-1"]', 'INV-NEW');
    await page.click('[data-action="save-billing"][data-id="dispatch-1"]');

    expect(billingBody).toEqual({ target_dispatch_id: 'dispatch-1', po_number_in: 'PO-NEW', invoice_number_in: 'INV-NEW' });
    await expect(page.locator('[data-challan-row="dispatch-1"]')).toContainText('PO-NEW');
    await expect(page.locator('[data-challan-row="dispatch-1"]')).toContainText('INV-NEW');
  });
});

test.describe('Delivery Challans — payment status', () => {
  test('an unauthorized challan shows no Pending/Paid selector', async ({ page }) => {
    await mockDispatches(page, [DISPATCH_UNAUTHORIZED]);
    await page.goto('/?demoRole=admin#/delivery-challans');
    await expect(page.locator('[data-challan-row="dispatch-1"] [data-action="status-select"]')).toHaveCount(0);
  });

  test('switching the status to Paid reveals a payment date field, and Save records it', async ({ page }) => {
    let requestCount = 0;
    await page.route('**/rest/v1/material_dispatch**', (route) => {
      requestCount += 1;
      const body = requestCount === 1 ? DISPATCH_AUTHORIZED : { ...DISPATCH_AUTHORIZED, payment_received_at: '2026-02-01T00:00:00Z', payment_date: '2026-01-31' };
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([body]) });
    });
    let paymentBody = null;
    await page.route('**/rest/v1/rpc/mark_dispatch_payment_received**', (route) => {
      paymentBody = route.request().postDataJSON();
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    });

    await page.goto('/?demoRole=admin#/delivery-challans');
    const row = page.locator('[data-challan-row="dispatch-2"]');
    await expect(row.locator('[data-action="payment-date"]')).toHaveCount(0);

    await row.locator('[data-action="status-select"]').selectOption('paid');
    await expect(row.locator('[data-action="payment-date"]')).toBeVisible();
    await row.locator('[data-action="payment-date"]').fill('2026-01-31');
    await row.locator('[data-action="payment-date"]').blur();
    await row.locator('[data-action="save-payment"]').click();

    expect(paymentBody).toEqual({ target_dispatch_id: 'dispatch-2', payment_date_in: '2026-01-31' });
    await expect(row).toContainText('Paid');
    await expect(row).toContainText('2026-01-31');
  });
});
