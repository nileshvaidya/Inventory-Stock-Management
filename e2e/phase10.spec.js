// Phase 10 — Bill Payments (attach a scanned bill file to an invoice,
// mark received). Network-mocked against demo mode, same approach as
// phase0-9. Real Storage RLS behavior is covered by
// scripts/test-rls-bill-payments.mjs.
import { test, expect } from '@playwright/test';

const INVOICE = {
  id: 'inv-1',
  invoice_number: 'INV-100',
  vendor: { name: 'Acme Supplies' },
  invoice_date: '2026-01-01',
  due_date: '2099-01-31',
  amount: 5000,
  paid_at: null,
  deleted_at: null,
  bill_file_path: null,
  bill_file_name: null,
  invoice_purchase_orders: [],
};

test.describe('Phase 10 — route guards', () => {
  test('admin (no access to Bill Payments) is redirected to the dashboard', async ({ page }) => {
    await page.goto('/?demoRole=admin#/bill-payments');
    await expect(page).toHaveURL(/#\/dashboard$/);
  });

  test('a role without Bill Payments access is redirected to the dashboard', async ({ page }) => {
    await page.goto('/?demoRole=store#/bill-payments');
    await expect(page).toHaveURL(/#\/dashboard$/);
  });
});

test.describe('Phase 10 — Bill Payments', () => {
  test('attaching a bill file uploads it to storage and records the path on the invoice', async ({ page }) => {
    let uploadedToPath = null;
    let patchBody = null;
    await page.route('**/rest/v1/invoices**', (route) => {
      if (route.request().method() === 'PATCH') {
        patchBody = route.request().postDataJSON();
        return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
      }
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([INVOICE]) });
    });
    await page.route('**/storage/v1/object/bill-documents/**', (route) => {
      uploadedToPath = new URL(route.request().url()).pathname;
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ Key: 'bill-documents/inv-1/file.pdf' }) });
    });

    await page.goto('/?demoRole=authorized#/bill-payments');
    await expect(page.locator('[data-screen="bill-payments"]')).toBeVisible();
    const row = page.locator('[data-invoice-row="inv-1"]');
    await expect(row).toContainText('No file');

    await row.locator('[data-action="bill-file"]').setInputFiles({ name: 'bill.pdf', mimeType: 'application/pdf', buffer: Buffer.from('fake pdf content') });

    await expect.poll(() => uploadedToPath).toContain('/storage/v1/object/bill-documents/inv-1/');
    await expect.poll(() => patchBody).toMatchObject({ bill_file_path: expect.stringContaining('inv-1/'), bill_file_name: 'bill.pdf' });
  });

  test('marking a bill received calls the same paid_at update as Invoices', async ({ page }) => {
    let patchBody = null;
    await page.route('**/rest/v1/invoices**', (route) => {
      if (route.request().method() === 'PATCH') {
        patchBody = route.request().postDataJSON();
        return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
      }
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([INVOICE]) });
    });

    await page.goto('/?demoRole=authorized#/bill-payments');
    const row = page.locator('[data-invoice-row="inv-1"]');
    await expect(row).toContainText('Pending');
    await row.locator('[data-action="mark-received"]').click();

    await expect.poll(() => patchBody).toHaveProperty('paid_at');
  });

  test('a received invoice shows Received status and no Mark Received button', async ({ page }) => {
    await page.route('**/rest/v1/invoices**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([{ ...INVOICE, id: 'inv-paid', paid_at: '2026-01-15T00:00:00Z', bill_file_path: 'inv-paid/file.pdf', bill_file_name: 'file.pdf' }]),
      })
    );

    await page.goto('/?demoRole=authorized#/bill-payments');
    const row = page.locator('[data-invoice-row="inv-paid"]');
    await expect(row).toContainText('Received');
    await expect(row).toContainText('file.pdf');
    await expect(row.locator('[data-action="mark-received"]')).toHaveCount(0);
  });

  test('shows an empty state when no invoices match', async ({ page }) => {
    await page.route('**/rest/v1/invoices**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));

    await page.goto('/?demoRole=authorized#/bill-payments');
    await expect(page.locator('[data-screen="bill-payments"]')).toContainText('No invoices match');
  });
});
