// Phase 5 — Invoices (link to one or more POs, payment terms/due dates,
// overdue status). Network-mocked against demo mode, same approach as
// phase0-4. Real RLS behavior is covered by scripts/test-rls-invoices.mjs.
import { test, expect } from '@playwright/test';

async function mockEmptyLookups(page) {
  await page.route('**/rest/v1/vendors**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  await page.route('**/rest/v1/purchase_orders**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
}

test.describe('Phase 5 — route guards', () => {
  test('a role without Invoices access is redirected to the dashboard', async ({ page }) => {
    await page.goto('/?demoRole=store#/invoices');
    await expect(page).toHaveURL(/#\/dashboard$/);
  });
});

test.describe('Phase 5 — Invoices', () => {
  test('creates an invoice linked to a PO, auto-computing the due date from payment terms', async ({ page }) => {
    await page.route('**/rest/v1/vendors**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([{ id: 'v1', name: 'Acme Supplies', default_payment_terms_days: 30 }]),
      })
    );
    await page.route('**/rest/v1/purchase_orders**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([{ id: 'po-1', po_number: 'PO-1001', vendor_id: 'v1', project: { name: 'Bridge Build' }, vendor: { name: 'Acme Supplies' } }]),
      })
    );
    let invoiceInsertBody = null;
    let linksInsertBody = null;
    await page.route('**/rest/v1/invoices**', (route) => {
      if (route.request().method() === 'POST') {
        invoiceInsertBody = route.request().postDataJSON();
        return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ id: 'inv-1', ...invoiceInsertBody }) });
      }
      return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
    });
    await page.route('**/rest/v1/invoice_purchase_orders**', (route) => {
      if (route.request().method() === 'POST') {
        linksInsertBody = route.request().postDataJSON();
        return route.fulfill({ status: 201, contentType: 'application/json', body: '[]' });
      }
      return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
    });

    await page.goto('/?demoRole=admin#/invoices');
    await expect(page.locator('[data-screen="invoices"]')).toBeVisible();
    await page.click('[data-action="toggle-form"]');
    await page.selectOption('[data-action="form-vendor"]', 'v1');

    // Payment terms auto-filled from the vendor's default (30 days) —
    // due date should be auto-computed from that + the invoice date.
    await expect(page.locator('[data-action="form-payment-terms"]')).toHaveValue('30');
    await page.fill('[data-action="form-invoice-date"]', '2026-01-01');
    await expect(page.locator('[data-action="form-due-date"]')).toHaveValue('2026-01-31');

    await page.fill('[data-action="form-amount"]', '5000');
    await page.check('[data-action="form-po"][value="po-1"]');
    await page.click('[data-action="save-invoice"]');

    await expect(page.locator('text=Invoice saved.')).toBeVisible();
    expect(invoiceInsertBody).toMatchObject({ vendor_id: 'v1', invoice_date: '2026-01-01', due_date: '2026-01-31', amount: 5000 });
    expect(linksInsertBody).toEqual([{ invoice_id: 'inv-1', po_id: 'po-1' }]);
  });

  test('saving without a vendor selected shows an error and never calls Supabase', async ({ page }) => {
    await mockEmptyLookups(page);
    let insertCalled = false;
    await page.route('**/rest/v1/invoices**', (route) => {
      if (route.request().method() === 'POST') insertCalled = true;
      route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    });

    await page.goto('/?demoRole=admin#/invoices');
    await page.click('[data-action="toggle-form"]');
    await page.fill('[data-action="form-amount"]', '100');
    await page.click('[data-action="save-invoice"]');

    await expect(page.locator('[data-role="save-error"]')).toBeVisible();
    expect(insertCalled).toBe(false);
  });

  test('lists invoices with computed status (paid/overdue/pending) and supports Mark Paid', async ({ page }) => {
    await mockEmptyLookups(page);
    let markPaidBody = null;
    await page.route('**/rest/v1/invoices**', (route) => {
      if (route.request().method() === 'PATCH') {
        markPaidBody = route.request().postDataJSON();
        return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
      }
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          {
            id: 'inv-overdue',
            invoice_number: 'INV-001',
            vendor: { name: 'Acme Supplies' },
            invoice_date: '2020-01-01',
            due_date: '2020-01-31',
            amount: 1000,
            paid_at: null,
            deleted_at: null,
            invoice_purchase_orders: [{ po: { po_number: 'PO-1001' } }],
          },
          {
            id: 'inv-paid',
            invoice_number: 'INV-002',
            vendor: { name: 'Acme Supplies' },
            invoice_date: '2026-01-01',
            due_date: '2026-01-31',
            amount: 2000,
            paid_at: '2026-01-15T00:00:00Z',
            deleted_at: null,
            invoice_purchase_orders: [],
          },
        ]),
      });
    });

    await page.goto('/?demoRole=admin#/invoices');
    const overdueRow = page.locator('[data-invoice-row="inv-overdue"]');
    await expect(overdueRow).toContainText('Overdue');
    await expect(overdueRow).toContainText('PO-1001');
    const paidRow = page.locator('[data-invoice-row="inv-paid"]');
    await expect(paidRow).toContainText('Paid');
    await expect(paidRow.locator('[data-action="mark-paid"]')).toHaveCount(0);

    await overdueRow.locator('[data-action="mark-paid"]').click();
    expect(markPaidBody).toHaveProperty('paid_at');
  });

  test('shows an empty state when no invoices match', async ({ page }) => {
    await mockEmptyLookups(page);
    await page.route('**/rest/v1/invoices**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));

    await page.goto('/?demoRole=admin#/invoices');
    await expect(page.locator('[data-screen="invoices"]')).toContainText('No invoices match');
  });
});
