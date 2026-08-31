// Phase 7 — Work Orders (nested BoM explosion + hard stock reservation).
// Network-mocked against demo mode, same approach as phase0-6. Real
// RLS/RPC behavior (including the netting explosion and the atomic
// re-availability check in reserve_work_order()) is covered by
// scripts/test-rls-work-orders.mjs.
import { test, expect } from '@playwright/test';

const ITEMS = [
  { id: 'item-widget', name: 'Widget', category: null, unit_of_measure: 'Nos.', reorder_level: null, deleted_at: null },
  { id: 'item-bolt', name: 'Bolt', category: null, unit_of_measure: 'Nos.', reorder_level: null, deleted_at: null },
];

function mockItems(page) {
  return page.route('**/rest/v1/items**', (route) => {
    if (route.request().method() === 'GET') {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(ITEMS) });
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
  });
}

test.describe('Phase 7 — route guards', () => {
  test('a role without Work Orders access is redirected to the dashboard', async ({ page }) => {
    await page.goto('/?demoRole=authorized#/work-orders');
    await expect(page).toHaveURL(/#\/dashboard$/);
  });
});

test.describe('Phase 7 — Work Orders', () => {
  test('previews an explosion, then creates a work order', async ({ page }) => {
    await mockItems(page);
    await page.route('**/rest/v1/work_orders**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));

    let previewBody = null;
    await page.route('**/rest/v1/rpc/explode_bom_requirements**', (route) => {
      previewBody = route.request().postDataJSON();
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([{ item_id: 'item-bolt', item_name: 'Bolt', reservable_qty: 40, shortfall_qty: 10 }]),
      });
    });

    let createBody = null;
    await page.route('**/rest/v1/rpc/create_work_order**', (route) => {
      createBody = route.request().postDataJSON();
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ id: 'wo-1', output_item_id: 'item-widget', quantity: 10, status: 'open' }),
      });
    });

    await page.goto('/?demoRole=admin#/work-orders');
    await expect(page.locator('[data-screen="work-orders"]')).toBeVisible();
    await page.click('[data-action="new-wo"]');

    await page.selectOption('[data-action="form-output-item"]', 'item-widget');
    await page.fill('[data-action="form-quantity"]', '10');
    await page.click('[data-action="check-availability"]');

    await expect(page.locator('[data-preview-row="item-bolt"]')).toContainText('Bolt');
    await expect(page.locator('[data-preview-row="item-bolt"]')).toContainText('40');
    await expect(page.locator('[data-preview-row="item-bolt"]')).toContainText('10 short');
    expect(previewBody).toEqual({ root_item_id: 'item-widget', root_qty: 10 });

    await page.click('[data-action="save-wo"]');

    await expect(page.locator('[data-role="wo-form"]')).toHaveCount(0);
    expect(createBody).toEqual({ target_output_item_id: 'item-widget', target_qty: 10, notes_in: null });
  });

  test('saving without selecting an item shows an error and never calls Supabase', async ({ page }) => {
    await mockItems(page);
    await page.route('**/rest/v1/work_orders**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    let createCalled = false;
    await page.route('**/rest/v1/rpc/create_work_order**', (route) => {
      createCalled = true;
      route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    });

    await page.goto('/?demoRole=admin#/work-orders');
    await page.click('[data-action="new-wo"]');
    await page.fill('[data-action="form-quantity"]', '10');
    await page.click('[data-action="save-wo"]');

    await expect(page.locator('[data-role="form-error"]')).toBeVisible();
    expect(createCalled).toBe(false);
  });

  test('shows a work order’s requirements and reserves stock for it', async ({ page }) => {
    await mockItems(page);
    let requestCount = 0;
    await page.route('**/rest/v1/work_orders**', (route) => {
      requestCount += 1;
      const status = requestCount === 1 ? 'open' : 'reserved';
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          {
            id: 'wo-1',
            output_item_id: 'item-widget',
            quantity: 10,
            status,
            notes: null,
            created_at: '2026-01-15T00:00:00Z',
            output_item: { id: 'item-widget', name: 'Widget', unit_of_measure: 'Nos.' },
          },
        ]),
      });
    });
    await page.route('**/rest/v1/work_order_requirements**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          { id: 'req-1', work_order_id: 'wo-1', item_id: 'item-bolt', reservable_qty: 40, shortfall_qty: 0, item: { id: 'item-bolt', name: 'Bolt', unit_of_measure: 'Nos.' } },
        ]),
      })
    );

    let reserveBody = null;
    await page.route('**/rest/v1/rpc/reserve_work_order**', (route) => {
      reserveBody = route.request().postDataJSON();
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ id: 'wo-1', status: 'reserved' }),
      });
    });

    await page.goto('/?demoRole=production#/work-orders');
    await expect(page.locator('[data-wo-row="wo-1"]')).toContainText('Widget');
    await page.click('[data-action="toggle-wo"][data-id="wo-1"]');
    await expect(page.locator('[data-wo-detail-row="wo-1"]')).toContainText('Bolt');

    await page.click('[data-action="reserve-wo"][data-id="wo-1"]');

    expect(reserveBody).toEqual({ target_work_order_id: 'wo-1' });
    await expect(page.locator('[data-wo-row="wo-1"] [data-role="wo-status"]')).toContainText('Reserved');
  });

  test('shows the server-side shortfall message when reserving is blocked', async ({ page }) => {
    await mockItems(page);
    await page.route('**/rest/v1/work_orders**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          {
            id: 'wo-1',
            output_item_id: 'item-widget',
            quantity: 10,
            status: 'open',
            notes: null,
            created_at: '2026-01-15T00:00:00Z',
            output_item: { id: 'item-widget', name: 'Widget', unit_of_measure: 'Nos.' },
          },
        ]),
      })
    );
    await page.route('**/rest/v1/work_order_requirements**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    await page.route('**/rest/v1/rpc/reserve_work_order**', (route) =>
      route.fulfill({
        status: 400,
        contentType: 'application/json',
        body: JSON.stringify({ message: 'Cannot reserve — stock has changed since this work order was created: Bolt (need 40, have 10 available); ' }),
      })
    );

    await page.goto('/?demoRole=admin#/work-orders');
    await page.click('[data-action="toggle-wo"][data-id="wo-1"]');
    await page.click('[data-action="reserve-wo"][data-id="wo-1"]');

    await expect(page.locator('[data-role="reserve-error"]')).toContainText('Cannot reserve');
  });

  test('cancels a work order', async ({ page }) => {
    await mockItems(page);
    await page.route('**/rest/v1/work_order_requirements**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));

    let cancelBody = null;
    let requestCount = 0;
    await page.route('**/rest/v1/work_orders**', (route) => {
      if (route.request().method() === 'PATCH') {
        cancelBody = route.request().postDataJSON();
        return route.fulfill({ status: 204, contentType: 'application/json', body: '' });
      }
      requestCount += 1;
      const status = requestCount === 1 ? 'open' : 'cancelled';
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          {
            id: 'wo-1',
            output_item_id: 'item-widget',
            quantity: 10,
            status,
            notes: null,
            created_at: '2026-01-15T00:00:00Z',
            output_item: { id: 'item-widget', name: 'Widget', unit_of_measure: 'Nos.' },
          },
        ]),
      });
    });

    await page.goto('/?demoRole=admin#/work-orders');
    await page.click('[data-action="toggle-wo"][data-id="wo-1"]');
    await page.click('[data-action="cancel-wo"][data-id="wo-1"]');

    expect(cancelBody).toEqual({ status: 'cancelled' });
    await expect(page.locator('[data-wo-row="wo-1"] [data-role="wo-status"]')).toContainText('Cancelled');
  });

  test('shows an empty state when no work orders exist', async ({ page }) => {
    await mockItems(page);
    await page.route('**/rest/v1/work_orders**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));

    await page.goto('/?demoRole=admin#/work-orders');
    await expect(page.locator('[data-screen="work-orders"]')).toContainText('No work orders yet.');
  });
});
