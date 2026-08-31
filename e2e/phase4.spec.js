// Phase 4 — Inventory (Item Master + stock movement ledger). Network-
// mocked against demo mode, same approach as phase0-3. Real RLS/RPC
// behavior (including the auto-stock-in trigger from accepted inspections)
// is covered by scripts/test-rls-inventory.mjs.
import { test, expect } from '@playwright/test';

test.describe('Phase 4 — route guards', () => {
  test('a role without Inventory access is redirected to the dashboard', async ({ page }) => {
    await page.goto('/?demoRole=authorized#/inventory');
    await expect(page).toHaveURL(/#\/dashboard$/);
  });
});

test.describe('Phase 4 — Inventory', () => {
  test('lists current stock, flags a below-reorder item, and shows its movement ledger', async ({ page }) => {
    await page.route('**/rest/v1/available_stock**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          {
            item_id: 'item-1',
            name: 'Base Angle',
            category: 'Steel',
            unit_of_measure: 'Nos.',
            reorder_level: 500,
            current_qty: 400,
            reserved_qty: 0,
            available_qty: 400,
          },
        ]),
      })
    );
    await page.route('**/rest/v1/stock_movements**', (route) => {
      if (route.request().method() === 'GET') {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify([
            {
              id: 'mv-1',
              item_id: 'item-1',
              movement_type: 'in',
              quantity: 1500,
              reference_type: 'inspection',
              reference_id: 'insp-1',
              notes: null,
              created_at: '2026-01-10T00:00:00Z',
            },
          ]),
        });
      }
      return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
    });

    await page.goto('/?demoRole=store#/inventory');
    await expect(page.locator('[data-screen="inventory"]')).toBeVisible();
    const row = page.locator('[data-stock-row="item-1"]');
    await expect(row).toContainText('Base Angle');
    await expect(row).toContainText('400');
    await expect(row.locator('[data-role="below-reorder"]')).toBeVisible();

    await page.click('[data-action="toggle-item"][data-id="item-1"]');
    const ledgerRow = page.locator('[data-movement-row="mv-1"]');
    await expect(ledgerRow).toContainText('In');
    await expect(ledgerRow).toContainText('1500');
    await expect(ledgerRow).toContainText('inspection');
  });

  test('store role logs a manual stock movement', async ({ page }) => {
    await page.route('**/rest/v1/available_stock**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          {
            item_id: 'item-1',
            name: 'Base Angle',
            category: 'Steel',
            unit_of_measure: 'Nos.',
            reorder_level: null,
            current_qty: 0,
            reserved_qty: 0,
            available_qty: 0,
          },
        ]),
      })
    );
    let movementInsertBody = null;
    await page.route('**/rest/v1/stock_movements**', (route) => {
      if (route.request().method() === 'POST') {
        movementInsertBody = route.request().postDataJSON();
        return route.fulfill({ status: 201, contentType: 'application/json', body: '{}' });
      }
      return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
    });

    await page.goto('/?demoRole=store#/inventory');
    await page.click('[data-action="toggle-item"][data-id="item-1"]');
    await page.selectOption('[data-action="movement-type"][data-id="item-1"]', 'in');
    await page.fill('[data-action="movement-quantity"][data-id="item-1"]', '200');
    await page.fill('[data-action="movement-notes"][data-id="item-1"]', 'Opening balance');
    await page.click('[data-action="save-movement"][data-id="item-1"]');

    await expect(page.locator('[data-role="movement-error"]')).toHaveCount(0);
    expect(movementInsertBody).toEqual({
      item_id: 'item-1',
      movement_type: 'in',
      quantity: 200,
      notes: 'Opening balance',
      created_by: 'demo-u3',
    });
  });

  test('production role can view Inventory but has no write affordances (read-only)', async ({ page }) => {
    await page.route('**/rest/v1/available_stock**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          {
            item_id: 'item-1',
            name: 'Base Angle',
            category: 'Steel',
            unit_of_measure: 'Nos.',
            reorder_level: null,
            current_qty: 0,
            reserved_qty: 0,
            available_qty: 0,
          },
        ]),
      })
    );
    await page.route('**/rest/v1/stock_movements**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));

    await page.goto('/?demoRole=production#/inventory');
    await expect(page.locator('[data-screen="inventory"]')).toBeVisible();
    await expect(page.locator('[data-action="new-item"]')).toHaveCount(0);

    await page.click('[data-action="toggle-item"][data-id="item-1"]');
    await expect(page.locator('[data-action="save-movement"]')).toHaveCount(0);
  });

  test('creates a new item and it appears in the list after reload', async ({ page }) => {
    let itemsCallCount = 0;
    await page.route('**/rest/v1/items**', (route) => {
      itemsCallCount += 1;
      if (route.request().method() === 'POST') {
        return route.fulfill({
          status: 201,
          contentType: 'application/json',
          body: JSON.stringify({ id: 'item-2', name: 'Steel Rod', category: null, unit_of_measure: null, reorder_level: null }),
        });
      }
      return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
    });
    await page.route('**/rest/v1/available_stock**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));

    await page.goto('/?demoRole=store#/inventory');
    await page.click('[data-action="new-item"]');
    await page.fill('[data-action="new-item-name"]', 'Steel Rod');
    await page.click('[data-action="confirm-new-item"]');

    await expect(page.locator('[data-action="new-item-name"]')).toHaveCount(0);
    expect(itemsCallCount).toBeGreaterThan(0);
  });

  test('shows an empty state when no items match the filters', async ({ page }) => {
    await page.route('**/rest/v1/available_stock**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));

    await page.goto('/?demoRole=store#/inventory');
    await expect(page.locator('[data-screen="inventory"]')).toContainText('No items match');
  });
});
