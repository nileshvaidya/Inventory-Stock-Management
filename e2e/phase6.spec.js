// Phase 6 — BoM Builder (nested bills of materials + recording
// production). Network-mocked against demo mode, same approach as
// phase0-5. Real RLS/RPC behavior (including the cycle guard and the
// atomic stock-shortfall check inside record_bom_production()) is covered
// by scripts/test-rls-boms.mjs.
import { test, expect } from '@playwright/test';

const ITEMS = [
  { id: 'item-widget', name: 'Widget', category: null, unit_of_measure: 'Nos.', reorder_level: null, deleted_at: null },
  { id: 'item-bolt', name: 'Bolt', category: null, unit_of_measure: 'Nos.', reorder_level: null, deleted_at: null },
  { id: 'item-plate', name: 'Plate', category: null, unit_of_measure: 'Nos.', reorder_level: null, deleted_at: null },
];

function mockItems(page) {
  return page.route('**/rest/v1/items**', (route) => {
    if (route.request().method() === 'GET') {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(ITEMS) });
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
  });
}

test.describe('Phase 6 — route guards', () => {
  test('a role without BoM Builder access is redirected to the dashboard', async ({ page }) => {
    await page.goto('/?demoRole=authorized#/bom-builder');
    await expect(page).toHaveURL(/#\/dashboard$/);
  });
});

test.describe('Phase 6 — BoM Builder', () => {
  test('creates a recipe with two components', async ({ page }) => {
    await mockItems(page);
    await page.route('**/rest/v1/bom_production_runs**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));

    let bomInsertBody = null;
    let componentsInsertBody = null;
    await page.route('**/rest/v1/boms**', (route) => {
      if (route.request().method() === 'POST') {
        bomInsertBody = route.request().postDataJSON();
        return route.fulfill({
          status: 201,
          contentType: 'application/json',
          body: JSON.stringify({ id: 'bom-1', output_item_id: 'item-widget', output_qty: 1, name: null, notes: null }),
        });
      }
      return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
    });
    await page.route('**/rest/v1/bom_components**', (route) => {
      if (route.request().method() === 'POST') {
        componentsInsertBody = route.request().postDataJSON();
        return route.fulfill({ status: 201, contentType: 'application/json', body: '[]' });
      }
      return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
    });

    await page.goto('/?demoRole=admin#/bom-builder');
    await expect(page.locator('[data-screen="bom-builder"]')).toBeVisible();
    await page.click('[data-action="new-bom"]');

    await page.selectOption('[data-action="form-output-item"]', 'item-widget');
    await page.fill('[data-action="form-output-qty"]', '1');

    await page.selectOption('[data-action="component-item"][data-idx="0"]', 'item-bolt');
    await page.fill('[data-action="component-quantity"][data-idx="0"]', '4');

    await page.click('[data-action="add-component"]');
    await page.selectOption('[data-action="component-item"][data-idx="1"]', 'item-plate');
    await page.fill('[data-action="component-quantity"][data-idx="1"]', '1');

    await page.click('[data-action="save-bom"]');

    await expect(page.locator('[data-role="bom-form"]')).toHaveCount(0);
    expect(bomInsertBody).toMatchObject({ output_item_id: 'item-widget', output_qty: 1 });
    expect(componentsInsertBody).toEqual([
      { bom_id: 'bom-1', component_item_id: 'item-bolt', quantity: 4 },
      { bom_id: 'bom-1', component_item_id: 'item-plate', quantity: 1 },
    ]);
  });

  test('saving with a component matching the output item shows an error and never calls Supabase', async ({ page }) => {
    await mockItems(page);
    await page.route('**/rest/v1/bom_production_runs**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    let insertCalled = false;
    await page.route('**/rest/v1/boms**', (route) => {
      if (route.request().method() === 'POST') insertCalled = true;
      route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
    });

    await page.goto('/?demoRole=admin#/bom-builder');
    await page.click('[data-action="new-bom"]');
    await page.selectOption('[data-action="form-output-item"]', 'item-widget');
    await page.fill('[data-action="form-output-qty"]', '1');
    await page.selectOption('[data-action="component-item"][data-idx="0"]', 'item-widget');
    await page.fill('[data-action="component-quantity"][data-idx="0"]', '2');
    await page.click('[data-action="save-bom"]');

    await expect(page.locator('[data-role="form-error"]')).toContainText('same item');
    expect(insertCalled).toBe(false);
  });

  test('shows a recipe’s components, records production, and refreshes its history', async ({ page }) => {
    await mockItems(page);
    await page.route('**/rest/v1/boms**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          {
            id: 'bom-1',
            output_item_id: 'item-widget',
            output_qty: 1,
            name: 'Widget Assembly',
            notes: null,
            output_item: { id: 'item-widget', name: 'Widget', unit_of_measure: 'Nos.' },
            components: [{ id: 'bc-1', component_item_id: 'item-bolt', quantity: 4, component_item: { id: 'item-bolt', name: 'Bolt', unit_of_measure: 'Nos.' } }],
          },
        ]),
      })
    );

    let runsRequestCount = 0;
    await page.route('**/rest/v1/bom_production_runs**', (route) => {
      runsRequestCount += 1;
      const body =
        runsRequestCount === 1
          ? []
          : [{ id: 'run-1', bom_id: 'bom-1', quantity_produced: 5, notes: null, created_at: '2026-01-15T00:00:00Z' }];
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    });

    let rpcBody = null;
    await page.route('**/rest/v1/rpc/record_bom_production**', (route) => {
      rpcBody = route.request().postDataJSON();
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ id: 'run-1', bom_id: 'bom-1', quantity_produced: 5 }),
      });
    });

    await page.goto('/?demoRole=production#/bom-builder');
    await expect(page.locator('[data-bom-row="bom-1"]')).toContainText('Widget');
    await page.click('[data-action="toggle-bom"][data-id="bom-1"]');
    await expect(page.locator('[data-bom-detail-row="bom-1"]')).toContainText('Bolt');
    await expect(page.locator('[data-bom-detail-row="bom-1"]')).toContainText('No production recorded yet.');

    await page.fill('[data-action="production-quantity"][data-id="bom-1"]', '5');
    await page.click('[data-action="save-production"][data-id="bom-1"]');

    await expect(page.locator('[data-role="production-success"]')).toBeVisible();
    expect(rpcBody).toEqual({ target_bom_id: 'bom-1', qty_produced: 5, notes_in: null });
    await expect(page.locator('[data-production-row="run-1"]')).toContainText('5');
  });

  test('shows the server-side shortfall message when production is blocked', async ({ page }) => {
    await mockItems(page);
    await page.route('**/rest/v1/boms**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          {
            id: 'bom-1',
            output_item_id: 'item-widget',
            output_qty: 1,
            name: null,
            notes: null,
            output_item: { id: 'item-widget', name: 'Widget', unit_of_measure: 'Nos.' },
            components: [{ id: 'bc-1', component_item_id: 'item-bolt', quantity: 100, component_item: { id: 'item-bolt', name: 'Bolt', unit_of_measure: 'Nos.' } }],
          },
        ]),
      })
    );
    await page.route('**/rest/v1/bom_production_runs**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    await page.route('**/rest/v1/rpc/record_bom_production**', (route) =>
      route.fulfill({
        status: 400,
        contentType: 'application/json',
        body: JSON.stringify({ message: 'Insufficient stock to record production: Bolt (need 500, have 10); ' }),
      })
    );

    await page.goto('/?demoRole=admin#/bom-builder');
    await page.click('[data-action="toggle-bom"][data-id="bom-1"]');
    await page.fill('[data-action="production-quantity"][data-id="bom-1"]', '5');
    await page.click('[data-action="save-production"][data-id="bom-1"]');

    await expect(page.locator('[data-role="production-error"]')).toContainText('Insufficient stock');
  });

  test('archives a recipe', async ({ page }) => {
    await mockItems(page);
    await page.route('**/rest/v1/bom_production_runs**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));

    let archiveBody = null;
    let requestCount = 0;
    await page.route('**/rest/v1/boms**', (route) => {
      if (route.request().method() === 'PATCH') {
        archiveBody = route.request().postDataJSON();
        return route.fulfill({ status: 204, contentType: 'application/json', body: '' });
      }
      requestCount += 1;
      const body =
        requestCount === 1
          ? [
              {
                id: 'bom-1',
                output_item_id: 'item-widget',
                output_qty: 1,
                name: null,
                notes: null,
                output_item: { id: 'item-widget', name: 'Widget', unit_of_measure: 'Nos.' },
                components: [],
              },
            ]
          : [];
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    });

    await page.goto('/?demoRole=admin#/bom-builder');
    await expect(page.locator('[data-bom-row="bom-1"]')).toBeVisible();
    await page.click('[data-action="toggle-bom"][data-id="bom-1"]');
    await page.click('[data-action="archive-bom"][data-id="bom-1"]');

    await expect(page.locator('[data-bom-row="bom-1"]')).toHaveCount(0);
    expect(archiveBody).toHaveProperty('deleted_at');
  });

  test('shows an empty state when no recipes exist', async ({ page }) => {
    await mockItems(page);
    await page.route('**/rest/v1/boms**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));

    await page.goto('/?demoRole=admin#/bom-builder');
    await expect(page.locator('[data-screen="bom-builder"]')).toContainText('No recipes yet.');
  });
});
