// Phase 8 — Reports (Stock & Reservations, Shortages, Below Reorder).
// Network-mocked against demo mode, same approach as phase0-7. No new
// schema/RLS this phase — everything here reads tables/views already
// covered by earlier phases' RLS integration scripts, so there's no new
// scripts/test-rls-*.mjs to go with it.
import { test, expect } from '@playwright/test';

test.describe('Phase 8 — route guards', () => {
  test('a role without Reports access is redirected to the dashboard', async ({ page }) => {
    await page.goto('/?demoRole=store#/reports');
    await expect(page).toHaveURL(/#\/dashboard$/);
  });
});

test.describe('Phase 8 — Reports', () => {
  test('Stock & Reservations tab lists reserved items and shows which work order holds one', async ({ page }) => {
    await page.route('**/rest/v1/available_stock**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          { item_id: 'item-bolt', name: 'Bolt', category: null, unit_of_measure: 'Nos.', reorder_level: null, current_qty: 100, reserved_qty: 40, available_qty: 60 },
          { item_id: 'item-plate', name: 'Plate', category: null, unit_of_measure: 'Nos.', reorder_level: null, current_qty: 10, reserved_qty: 0, available_qty: 10 },
        ]),
      })
    );
    await page.route('**/rest/v1/stock_reservations**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          {
            id: 'res-1',
            item_id: 'item-bolt',
            quantity: 40,
            item: { id: 'item-bolt', name: 'Bolt', unit_of_measure: 'Nos.' },
            work_order: { id: 'wo-1', quantity: 10, status: 'reserved', output_item: { id: 'item-widget', name: 'Widget' } },
          },
        ]),
      })
    );
    await page.route('**/rest/v1/work_order_requirements**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));

    await page.goto('/?demoRole=admin#/reports');
    await expect(page.locator('[data-screen="reports"]')).toBeVisible();
    await expect(page.locator('[data-reservation-row="item-bolt"]')).toContainText('Bolt');
    await expect(page.locator('[data-reservation-row="item-bolt"]')).toContainText('40');
    await expect(page.locator('[data-reservation-row="item-plate"]')).toHaveCount(0);

    await page.click('[data-action="toggle-item"][data-id="item-bolt"]');
    await expect(page.locator('[data-reservation-detail-row="item-bolt"]')).toContainText('Widget');
    await expect(page.locator('[data-reservation-detail-row="item-bolt"]')).toContainText('40');
  });

  test('Shortages tab lists components short against open/reserved work orders', async ({ page }) => {
    await page.route('**/rest/v1/available_stock**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    await page.route('**/rest/v1/stock_reservations**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    await page.route('**/rest/v1/work_order_requirements**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          {
            id: 'req-1',
            item_id: 'item-bolt',
            shortfall_qty: 15,
            item: { id: 'item-bolt', name: 'Bolt', unit_of_measure: 'Nos.' },
            work_order: { id: 'wo-1', quantity: 10, status: 'open', output_item: { id: 'item-widget', name: 'Widget' } },
          },
        ]),
      })
    );

    await page.goto('/?demoRole=authorized#/reports');
    await page.click('[data-action="switch-tab"][data-tab="shortages"]');

    const row = page.locator('[data-shortage-row="req-1"]');
    await expect(row).toContainText('Bolt');
    await expect(row).toContainText('Widget');
    await expect(row).toContainText('15');
  });

  test('Below Reorder tab lists items whose available quantity is under reorder level', async ({ page }) => {
    await page.route('**/rest/v1/available_stock**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          { item_id: 'item-bolt', name: 'Bolt', category: 'Hardware', unit_of_measure: 'Nos.', reorder_level: 50, current_qty: 100, reserved_qty: 60, available_qty: 40 },
          { item_id: 'item-plate', name: 'Plate', category: null, unit_of_measure: 'Nos.', reorder_level: 5, current_qty: 10, reserved_qty: 0, available_qty: 10 },
        ]),
      })
    );
    await page.route('**/rest/v1/stock_reservations**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    await page.route('**/rest/v1/work_order_requirements**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));

    await page.goto('/?demoRole=production#/reports');
    await page.click('[data-action="switch-tab"][data-tab="below-reorder"]');

    await expect(page.locator('[data-below-reorder-row="item-bolt"]')).toContainText('Bolt');
    await expect(page.locator('[data-below-reorder-row="item-plate"]')).toHaveCount(0);
  });

  test('exports the active tab to CSV', async ({ page }) => {
    await page.route('**/rest/v1/available_stock**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          { item_id: 'item-bolt', name: 'Bolt', category: null, unit_of_measure: 'Nos.', reorder_level: null, current_qty: 100, reserved_qty: 40, available_qty: 60 },
        ]),
      })
    );
    await page.route('**/rest/v1/stock_reservations**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    await page.route('**/rest/v1/work_order_requirements**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));

    await page.goto('/?demoRole=admin#/reports');
    const downloadPromise = page.waitForEvent('download');
    await page.click('[data-action="export-csv"]');
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/^reports-stock-reservations-.*\.csv$/);
  });

  test('shows empty states for each tab', async ({ page }) => {
    await page.route('**/rest/v1/available_stock**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    await page.route('**/rest/v1/stock_reservations**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    await page.route('**/rest/v1/work_order_requirements**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));

    await page.goto('/?demoRole=admin#/reports');
    await expect(page.locator('[data-screen="reports"]')).toContainText('No active reservations.');
    await page.click('[data-action="switch-tab"][data-tab="shortages"]');
    await expect(page.locator('[data-screen="reports"]')).toContainText('No shortages against any open or reserved work order.');
    await page.click('[data-action="switch-tab"][data-tab="below-reorder"]');
    await expect(page.locator('[data-screen="reports"]')).toContainText('No items are below their reorder level.');
  });
});
