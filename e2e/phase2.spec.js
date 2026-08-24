// Phase 2 — PO Upload, Order Status. Network-mocked against demo mode,
// same approach as phase0/phase1. Real PDF parsing is covered by
// src/pdfParser.test.js (pure logic, no PDF binary fixture needed here);
// real RLS/RPC behavior is covered by scripts/test-rls-purchase-orders.mjs.
import { test, expect } from '@playwright/test';

async function mockEmptyLookups(page) {
  await page.route('**/rest/v1/projects**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  await page.route('**/rest/v1/vendors**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
}

test.describe('Phase 2 — route guards', () => {
  test('a non-purchase role navigating to #/po-upload is redirected to the dashboard', async ({ page }) => {
    await page.goto('/?demoRole=store#/po-upload');
    await expect(page).toHaveURL(/#\/dashboard$/);
  });

  test('a non-purchase role navigating to #/order-status is redirected to the dashboard', async ({ page }) => {
    await page.goto('/?demoRole=store#/order-status');
    await expect(page).toHaveURL(/#\/dashboard$/);
  });
});

test.describe('Phase 2 — PO Upload', () => {
  test('admin can add a line item row by hand and sees the computed amount', async ({ page }) => {
    await mockEmptyLookups(page);
    await page.goto('/?demoRole=admin#/po-upload');
    await expect(page.locator('[data-screen="po-upload"]')).toBeVisible();

    await page.click('[data-action="add-row"]');
    await page.fill('[data-action="item-name"][data-index="0"]', 'Widget');
    await page.fill('[data-action="item-qty"][data-index="0"]', '10');
    await page.fill('[data-action="item-rate"][data-index="0"]', '2.5');

    const row = page.locator('[data-line-item-row="0"]');
    await expect(row).toContainText('25.00');
  });

  test('saving without a project selected shows an error and never calls Supabase', async ({ page }) => {
    await mockEmptyLookups(page);
    let insertCalled = false;
    await page.route('**/rest/v1/purchase_orders**', (route) => {
      insertCalled = true;
      route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    });

    await page.goto('/?demoRole=admin#/po-upload');
    await page.click('[data-action="add-row"]');
    await page.fill('[data-action="item-name"][data-index="0"]', 'Widget');
    await page.fill('[data-action="item-qty"][data-index="0"]', '10');
    await page.fill('[data-action="item-rate"][data-index="0"]', '2.5');
    await page.click('[data-action="save"]');

    await expect(page.locator('[data-role="save-error"]')).toBeVisible();
    expect(insertCalled).toBe(false);
  });

  test('Map Fields Manually: pasted text can be built into a line item by clicking words (P2 field-mapping fallback)', async ({ page }) => {
    await mockEmptyLookups(page);
    await page.goto('/?demoRole=admin#/po-upload');

    await page.click('[data-action="toggle-mapping"]');
    // "Base Angle 1500 45 Nos" is deliberately a shape pdfParser.js's
    // built-in regexes don't recognize (qty/rate adjacent with no marker,
    // then a trailing unit-of-measure word) — so the only way this becomes
    // a line item here is via manual field mapping, not the auto-parser.
    await page.fill('[data-action="paste-text"]', 'Base Angle 1500 45 Nos');
    await page.click('[data-action="use-pasted-text"]');

    await expect(page.locator('[data-role="raw-line"]')).toContainText('Base Angle 1500 45 Nos');
    await expect(page.locator('[data-line-item-row]')).toHaveCount(0);
    await page.click('[data-action="select-map-line"][data-index="0"]');

    // Item Name is the active slot by default after picking a line.
    await page.click('[data-action="map-token"][data-token-index="0"]'); // "Base"
    await page.click('[data-action="map-token"][data-token-index="1"]'); // "Angle"
    await page.click('[data-action="set-active-slot"][data-slot="qty"]');
    await page.click('[data-action="map-token"][data-token-index="2"]'); // "1500"
    await page.click('[data-action="set-active-slot"][data-slot="rate"]');
    await page.click('[data-action="map-token"][data-token-index="3"]'); // "45"

    await page.click('[data-action="add-mapped-row"]');

    const row = page.locator('[data-line-item-row="0"]');
    await expect(row.locator('[data-action="item-name"]')).toHaveValue('Base Angle');
    await expect(row).toContainText('67500.00');
  });

  test('Map Fields Manually: "Remember this layout" saves a per-vendor template', async ({ page }) => {
    await page.route('**/rest/v1/projects**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    await page.route('**/rest/v1/vendors**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([{ id: 'v1', name: 'Acme Supplies', gstin: null, contact: null, default_payment_terms_days: null }]),
      })
    );
    let mappingSaveCalled = false;
    await page.route('**/rest/v1/import_field_mappings**', (route) => {
      mappingSaveCalled = true;
      route.fulfill({ status: 201, contentType: 'application/json', body: '{}' });
    });

    await page.goto('/?demoRole=admin#/po-upload');
    await page.selectOption('[data-action="vendor-select"]', 'v1');

    await page.click('[data-action="toggle-mapping"]');
    await page.fill('[data-action="paste-text"]', 'Base Angle 1500 45 Nos');
    await page.click('[data-action="use-pasted-text"]');
    await page.click('[data-action="select-map-line"][data-index="0"]');
    await page.click('[data-action="map-token"][data-token-index="0"]');
    await page.click('[data-action="map-token"][data-token-index="1"]');
    await page.click('[data-action="set-active-slot"][data-slot="qty"]');
    await page.click('[data-action="map-token"][data-token-index="2"]');
    await page.click('[data-action="set-active-slot"][data-slot="rate"]');
    await page.click('[data-action="map-token"][data-token-index="3"]');
    await page.click('[data-action="add-mapped-row"]');

    await expect(page.locator('[data-action="remember-layout"]')).toContainText('Acme Supplies');
    await page.click('[data-action="remember-layout"]');

    await expect(page.getByText('Layout remembered')).toBeVisible();
    expect(mappingSaveCalled).toBe(true);
  });

  test('"+ New" creates and selects a project inline (P2-3)', async ({ page }) => {
    await mockEmptyLookups(page);
    await page.route('**/rest/v1/projects**', (route) => {
      if (route.request().method() === 'POST') {
        return route.fulfill({
          status: 201,
          contentType: 'application/json',
          body: JSON.stringify({ id: 'new-project-1', name: 'New Bridge Build' }),
        });
      }
      return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
    });

    await page.goto('/?demoRole=admin#/po-upload');
    await page.click('[data-action="new-project"]');
    await page.fill('[data-role="new-project-name"]', 'New Bridge Build');
    await page.click('[data-action="confirm-new-project"]');

    const projectSelect = page.locator('[data-action="project-select"]');
    await expect(projectSelect).toBeVisible();
    await expect(projectSelect.locator('option', { hasText: 'New Bridge Build' })).toHaveCount(1);
  });
});

test.describe('Phase 2 — Order Status', () => {
  test('lists purchase orders with their status label and supports CSV export', async ({ page }) => {
    await page.route('**/rest/v1/projects**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    await page.route('**/rest/v1/purchase_orders**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          {
            id: 'po-1',
            po_number: 'PO-1001',
            order_date: '2026-01-15',
            status: 'to_be_received',
            deleted_at: null,
            project: { id: 'p1', name: 'Bridge Build' },
            vendor: { id: 'v1', name: 'Acme Supplies' },
          },
        ]),
      })
    );

    await page.goto('/?demoRole=admin#/order-status');
    await expect(page.locator('[data-screen="order-status"]')).toBeVisible();
    const row = page.locator('[data-po-row="po-1"]');
    await expect(row).toContainText('PO-1001');
    await expect(row).toContainText('Bridge Build');
    await expect(row).toContainText('To Be Received');

    const downloadPromise = page.waitForEvent('download');
    await page.click('[data-action="export-csv"]');
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/^order-status-.*\.csv$/);
  });

  test('shows an empty state when no purchase orders match', async ({ page }) => {
    await page.route('**/rest/v1/projects**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    await page.route('**/rest/v1/purchase_orders**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));

    await page.goto('/?demoRole=admin#/order-status');
    await expect(page.locator('[data-screen="order-status"]')).toContainText('No purchase orders match');
  });
});
