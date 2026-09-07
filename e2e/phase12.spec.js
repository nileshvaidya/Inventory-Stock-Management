// Phase 12 — Price History and Stock Statement. Network-mocked against
// demo mode, same approach as phase0-11. Item Unit Rate on Inventory
// itself is covered by e2e/phase4.spec.js (its own screen); real RLS/RPC
// behavior (item_price_history's insert-only policy, the two views) is
// covered by scripts/test-rls-item-pricing.mjs against a real database.
import { test, expect } from '@playwright/test';

test.describe('Phase 12 — route guards', () => {
  test('a role without Price History access is redirected to the dashboard', async ({ page }) => {
    await page.goto('/?demoRole=authorized#/price-history');
    await expect(page).toHaveURL(/#\/dashboard$/);
  });

  test('a role without Stock Statement access is redirected to the dashboard', async ({ page }) => {
    await page.goto('/?demoRole=store#/stock-statement');
    await expect(page).toHaveURL(/#\/dashboard$/);
  });
});

test.describe('Phase 12 — Price History', () => {
  test('lists every rate change and filters by item and date range with the right params', async ({ page }) => {
    await page.route('**/rest/v1/items**', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ id: 'item-1', name: 'Widget' }]) })
    );
    let lastUrl = '';
    await page.route('**/rest/v1/item_price_history**', (route) => {
      lastUrl = route.request().url();
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          {
            id: 'ph-1',
            item_id: 'item-1',
            rate: 45.5,
            effective_date: '2026-02-01',
            created_at: '2026-02-01T10:00:00Z',
            item: { id: 'item-1', name: 'Widget' },
            created_by_user: { id: 'demo-u1', name: 'Demo Admin' },
          },
        ]),
      });
    });

    await page.goto('/?demoRole=admin#/price-history');
    await expect(page.locator('[data-screen="price-history"]')).toBeVisible();
    const row = page.locator('[data-price-history-row="ph-1"]');
    await expect(row).toContainText('Widget');
    await expect(row).toContainText('45.50');
    await expect(row).toContainText('Demo Admin');

    await page.selectOption('[data-action="filter-item"]', 'item-1');
    await expect.poll(() => lastUrl).toContain('item_id=eq.item-1');

    await page.fill('[data-action="filter-date-from"]', '2026-01-01');
    await page.locator('[data-action="filter-date-from"]').blur();
    await expect.poll(() => lastUrl).toContain('effective_date=gte.2026-01-01');

    await page.fill('[data-action="filter-date-to"]', '2026-03-01');
    await page.locator('[data-action="filter-date-to"]').blur();
    await expect.poll(() => lastUrl).toContain('effective_date=lte.2026-03-01');
  });

  test('shows an empty state when no price changes match the filters', async ({ page }) => {
    await page.route('**/rest/v1/items**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    await page.route('**/rest/v1/item_price_history**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));

    await page.goto('/?demoRole=admin#/price-history');
    await expect(page.locator('[data-screen="price-history"]')).toContainText('No price changes match these filters.');
  });
});

test.describe('Phase 12 — Stock Statement', () => {
  test('renders a printable statement with Opening/Inward/Outward/Closing columns and a total, excluding items with no rate', async ({ page }) => {
    await page.route('**/rest/v1/rpc/stock_statement_for_range**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          {
            item_id: 'item-1', item_code: 'RM-001', name: 'Widget', item_type: 'RM', source: 'Acme Vendors', location: 'Rack A1',
            unit_of_measure: 'Nos.', opening_qty: 80, inward_qty: 30, outward_qty: 10, closing_qty: 100,
            rate: 45.5, rate_effective_date: '2026-02-01', stock_value: 4550,
          },
          {
            item_id: 'item-2', item_code: 'RM-002', name: 'Bolt', item_type: 'RM', source: null, location: null,
            unit_of_measure: 'Nos.', opening_qty: 500, inward_qty: 0, outward_qty: 0, closing_qty: 500,
            rate: null, rate_effective_date: null, stock_value: null,
          },
        ]),
      })
    );

    await page.goto('/?demoRole=admin#/stock-statement');
    await expect(page.locator('[data-role="stock-statement-sheet"]')).toBeVisible();
    await expect(page.locator('[data-screen="stock-statement"]')).toContainText('ASK Info-Solutions LLP');

    const widgetRow = page.locator('[data-statement-row="item-1"]');
    await expect(widgetRow).toContainText('RM-001');
    await expect(widgetRow).toContainText('Widget');
    await expect(widgetRow).toContainText('Raw Material');
    await expect(widgetRow).toContainText('Acme Vendors');
    await expect(widgetRow).toContainText('Rack A1');
    await expect(widgetRow).toContainText('80');
    await expect(widgetRow).toContainText('30');
    await expect(widgetRow).toContainText('10');
    await expect(widgetRow).toContainText('100');
    await expect(widgetRow).toContainText('45.50');
    await expect(widgetRow).toContainText('4550.00');

    const boltRow = page.locator('[data-statement-row="item-2"]');
    await expect(boltRow).toContainText('Bolt');
    await expect(boltRow).toContainText('—');

    // Total sums only the priced item — 500 unpriced Bolt units are never
    // silently valued at zero, they're excluded and called out instead.
    await expect(page.locator('[data-role="statement-total"]')).toHaveText('₹4550.00');
    await expect(page.locator('[data-role="statement-unpriced-note"]')).toContainText('1 item(s)');
  });

  test('shows an empty state when no items are recorded yet', async ({ page }) => {
    await page.route('**/rest/v1/rpc/stock_statement_for_range**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));

    await page.goto('/?demoRole=admin#/stock-statement');
    await expect(page.locator('[data-role="stock-statement-sheet"]')).toContainText('No items recorded yet.');
  });

  test('the Print button calls window.print()', async ({ page }) => {
    await page.route('**/rest/v1/rpc/stock_statement_for_range**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          {
            item_id: 'item-1', item_code: null, name: 'Widget', item_type: null, source: null, location: null,
            unit_of_measure: 'Nos.', opening_qty: 5, inward_qty: 5, outward_qty: 0, closing_qty: 10,
            rate: 5, rate_effective_date: '2026-01-01', stock_value: 50,
          },
        ]),
      })
    );

    await page.goto('/?demoRole=admin#/stock-statement');
    await expect(page.locator('[data-role="stock-statement-sheet"]')).toBeVisible();

    let printCalled = false;
    await page.exposeFunction('__printCalled', () => {
      printCalled = true;
    });
    await page.evaluate(() => {
      window.print = () => window.__printCalled();
    });

    await page.click('[data-action="print"]');
    await expect.poll(() => printCalled).toBe(true);
  });

  test('changing the From/To date filter re-fetches the statement for that range', async ({ page }) => {
    const seenRanges = [];
    await page.route('**/rest/v1/rpc/stock_statement_for_range**', (route) => {
      const body = route.request().postDataJSON();
      seenRanges.push({ date_from: body.date_from, date_to: body.date_to });
      route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
    });

    await page.goto('/?demoRole=admin#/stock-statement');
    await expect(page.locator('[data-role="stock-statement-sheet"]')).toBeVisible();
    expect(seenRanges.length).toBeGreaterThan(0);

    await page.fill('[data-action="filter-date-from"]', '2026-01-01');
    await page.locator('[data-action="filter-date-from"]').blur();
    await expect.poll(() => seenRanges[seenRanges.length - 1]?.date_from).toBe('2026-01-01');

    await page.fill('[data-action="filter-date-to"]', '2026-01-31');
    await page.locator('[data-action="filter-date-to"]').blur();
    await expect.poll(() => seenRanges[seenRanges.length - 1]).toEqual({ date_from: '2026-01-01', date_to: '2026-01-31' });
    await expect(page.locator('[data-screen="stock-statement"]')).toContainText('01 Jan 2026');
    await expect(page.locator('[data-screen="stock-statement"]')).toContainText('31 Jan 2026');
  });
});
