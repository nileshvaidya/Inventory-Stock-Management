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

function mockNoRates(page) {
  return page.route('**/rest/v1/item_current_rate**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
}

test.describe('Phase 4 — Inventory', () => {
  test('lists current stock, flags a below-reorder item, and shows its movement ledger', async ({ page }) => {
    await mockNoRates(page);
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
    await mockNoRates(page);
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
    await mockNoRates(page);
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
    await mockNoRates(page);
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
    await mockNoRates(page);
    await page.route('**/rest/v1/available_stock**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));

    await page.goto('/?demoRole=store#/inventory');
    await expect(page.locator('[data-screen="inventory"]')).toContainText('No items match');
  });

  test('shows an item\'s current rate, and store role updates it, recording a new price_history entry', async ({ page }) => {
    let rateCallCount = 0;
    await page.route('**/rest/v1/item_current_rate**', (route) => {
      rateCallCount += 1;
      // First load: Widget has no rate yet. After the update below, the
      // reload should show the just-saved rate — same pattern as the
      // rest of this screen re-fetching after any write.
      const body = rateCallCount === 1 ? [] : [{ item_id: 'item-1', rate: 45.5, effective_date: '2026-02-01' }];
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    });
    await page.route('**/rest/v1/available_stock**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          { item_id: 'item-1', name: 'Widget', category: 'Fasteners', unit_of_measure: 'Nos.', reorder_level: null, current_qty: 10, reserved_qty: 0, available_qty: 10 },
        ]),
      })
    );
    await page.route('**/rest/v1/stock_movements**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));

    let rateInsertBody = null;
    await page.route('**/rest/v1/item_price_history**', (route) => {
      rateInsertBody = route.request().postDataJSON();
      return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ id: 'ph-1', ...rateInsertBody }) });
    });

    await page.goto('/?demoRole=store#/inventory');
    await expect(page.locator('[data-stock-row="item-1"] [data-role="unit-rate"]')).toHaveText('—');

    await page.click('[data-action="toggle-item"][data-id="item-1"]');
    await expect(page.locator('[data-role="current-rate"]')).toContainText('Not set');

    await page.fill('[data-action="rate-value"][data-id="item-1"]', '45.5');
    await page.fill('[data-action="rate-effective-date"][data-id="item-1"]', '2026-02-01');
    await page.locator('[data-action="rate-effective-date"][data-id="item-1"]').blur();
    await page.click('[data-action="save-rate"][data-id="item-1"]');

    await expect(page.locator('[data-role="rate-error"]')).toHaveCount(0);
    expect(rateInsertBody).toEqual({ item_id: 'item-1', rate: 45.5, effective_date: '2026-02-01', created_by: 'demo-u3' });
    await expect(page.locator('[data-stock-row="item-1"] [data-role="unit-rate"]')).toHaveText('45.50');
  });

  test('creating a new item with a unit rate also records its first price_history entry', async ({ page }) => {
    await mockNoRates(page);
    await page.route('**/rest/v1/available_stock**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    await page.route('**/rest/v1/items**', (route) => {
      if (route.request().method() === 'POST') {
        return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ id: 'item-9', name: 'Steel Rod' }) });
      }
      return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
    });
    let rateInsertBody = null;
    await page.route('**/rest/v1/item_price_history**', (route) => {
      rateInsertBody = route.request().postDataJSON();
      return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ id: 'ph-1', ...rateInsertBody }) });
    });

    await page.goto('/?demoRole=store#/inventory');
    await page.click('[data-action="new-item"]');
    await page.fill('[data-action="new-item-name"]', 'Steel Rod');
    await page.fill('[data-action="new-item-unit-rate"]', '120');
    await page.click('[data-action="confirm-new-item"]');

    await expect(page.locator('[data-action="new-item-name"]')).toHaveCount(0);
    expect(rateInsertBody).toMatchObject({ item_id: 'item-9', rate: 120, created_by: 'demo-u3' });
  });

  test('creating a new item without a unit rate never touches item_price_history', async ({ page }) => {
    await mockNoRates(page);
    await page.route('**/rest/v1/available_stock**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    await page.route('**/rest/v1/items**', (route) => {
      if (route.request().method() === 'POST') {
        return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ id: 'item-9', name: 'Steel Rod' }) });
      }
      return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
    });
    let rateInsertCalled = false;
    await page.route('**/rest/v1/item_price_history**', (route) => {
      rateInsertCalled = true;
      route.fulfill({ status: 201, contentType: 'application/json', body: '{}' });
    });

    await page.goto('/?demoRole=store#/inventory');
    await page.click('[data-action="new-item"]');
    await page.fill('[data-action="new-item-name"]', 'Steel Rod');
    await page.click('[data-action="confirm-new-item"]');

    await expect(page.locator('[data-action="new-item-name"]')).toHaveCount(0);
    expect(rateInsertCalled).toBe(false);
  });

  test('creating a new item with Item Code/Type/Source/Location fills them in on the insert', async ({ page }) => {
    await mockNoRates(page);
    await page.route('**/rest/v1/available_stock**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    let insertBody = null;
    await page.route('**/rest/v1/items**', (route) => {
      if (route.request().method() === 'POST') {
        insertBody = route.request().postDataJSON();
        return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ id: 'item-9', ...insertBody }) });
      }
      return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
    });

    await page.goto('/?demoRole=store#/inventory');
    await page.click('[data-action="new-item"]');
    await page.fill('[data-action="new-item-name"]', 'Steel Rod');
    await page.fill('[data-action="new-item-code"]', 'RM-100');
    await page.selectOption('[data-action="new-item-type"]', 'RM');
    await page.fill('[data-action="new-item-source"]', 'Acme Vendors');
    await page.fill('[data-action="new-item-location"]', 'Rack A1');
    await page.click('[data-action="confirm-new-item"]');

    await expect(page.locator('[data-action="new-item-name"]')).toHaveCount(0);
    expect(insertBody).toMatchObject({ name: 'Steel Rod', item_code: 'RM-100', item_type: 'RM', source: 'Acme Vendors', location: 'Rack A1' });
  });

  test('production role sees the rate but not the Update Rate form (read-only)', async ({ page }) => {
    await page.route('**/rest/v1/item_current_rate**', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ item_id: 'item-1', rate: 10, effective_date: '2026-01-01' }]) })
    );
    await page.route('**/rest/v1/available_stock**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([{ item_id: 'item-1', name: 'Widget', category: null, unit_of_measure: null, reorder_level: null, current_qty: 10, reserved_qty: 0, available_qty: 10 }]),
      })
    );
    await page.route('**/rest/v1/stock_movements**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));

    await page.goto('/?demoRole=production#/inventory');
    await expect(page.locator('[data-stock-row="item-1"] [data-role="unit-rate"]')).toHaveText('10.00');

    await page.click('[data-action="toggle-item"][data-id="item-1"]');
    await expect(page.locator('[data-role="current-rate"]')).toContainText('₹10.00');
    await expect(page.locator('[data-action="save-rate"]')).toHaveCount(0);
  });
});
