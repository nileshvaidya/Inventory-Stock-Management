// Phase 9 — Action Log. Network-mocked against demo mode, same approach
// as phase0-8. Real trigger/RLS behavior (trg_log_action() firing on
// every mutable table, including writes made through a security-definer
// RPC, admin-only read, and direct-insert blocking) is covered by
// scripts/test-rls-action-log.mjs.
import { test, expect } from '@playwright/test';

test.describe('Phase 9 — route guards', () => {
  test('a role without Action Log access is redirected to the dashboard', async ({ page }) => {
    await page.goto('/?demoRole=store#/action-log');
    await expect(page).toHaveURL(/#\/dashboard$/);
  });
});

test.describe('Phase 9 — Action Log', () => {
  test('lists actions and shows before/after details', async ({ page }) => {
    await page.route('**/rest/v1/rpc/admin_list_users**', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ id: 'demo-u1', name: 'Admin User', email: 'admin@example.com', role: 'admin', status: 'active' }]) })
    );
    await page.route('**/rest/v1/action_log**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          {
            id: 'log-1',
            table_name: 'purchase_orders',
            operation: 'UPDATE',
            row_id: 'po-1',
            user_id: 'demo-u1',
            old_data: { status: 'to_be_received' },
            new_data: { status: 'received_inspected' },
            created_at: '2026-01-15T10:00:00Z',
            user: { id: 'demo-u1', name: 'Admin User', email: 'admin@example.com' },
          },
        ]),
      })
    );

    await page.goto('/?demoRole=admin#/action-log');
    await expect(page.locator('[data-screen="action-log"]')).toBeVisible();
    const row = page.locator('[data-action-row="log-1"]');
    await expect(row).toContainText('Admin User');
    await expect(row).toContainText('Purchase Order Updated');

    await page.click('[data-action="toggle-row"][data-id="log-1"]');
    const detail = page.locator('[data-action-detail-row="log-1"]');
    await expect(detail).toContainText('to_be_received');
    await expect(detail).toContainText('received_inspected');
  });

  test('filtering by user, record type, action, and date range queries with the right params', async ({ page }) => {
    await page.route('**/rest/v1/rpc/admin_list_users**', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ id: 'demo-u3', name: 'Store User', email: 'store@example.com', role: 'store', status: 'active' }]) })
    );

    let lastUrl = '';
    await page.route('**/rest/v1/action_log**', (route) => {
      lastUrl = route.request().url();
      return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
    });

    await page.goto('/?demoRole=admin#/action-log');
    await page.selectOption('[data-action="filter-user"]', 'demo-u3');
    await expect.poll(() => lastUrl).toContain('user_id=eq.demo-u3');

    await page.selectOption('[data-action="filter-table"]', 'items');
    await expect.poll(() => lastUrl).toContain('table_name=eq.items');

    await page.selectOption('[data-action="filter-operation"]', 'DELETE');
    await expect.poll(() => lastUrl).toContain('operation=eq.DELETE');

    // The date filters only sync to app state on blur (see
    // src/screens/actionLog.js — re-rendering while a native date picker
    // still has focus can corrupt its in-progress segment), so leave the
    // field before checking; fill() alone doesn't trigger blur.
    await page.fill('[data-action="filter-date-from"]', '2026-01-01');
    await page.locator('[data-action="filter-date-from"]').blur();
    await expect.poll(() => lastUrl).toContain('created_at=gte.2026-01-01');

    await page.fill('[data-action="filter-date-to"]', '2026-01-31');
    await page.locator('[data-action="filter-date-to"]').blur();
    // Inclusive of the whole "To" day: the query uses an exclusive upper
    // bound of the *next* day, not the literal typed date.
    await expect.poll(() => lastUrl).toContain('created_at=lt.2026-02-01');
  });

  test('exports the filtered log to CSV', async ({ page }) => {
    await page.route('**/rest/v1/rpc/admin_list_users**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    await page.route('**/rest/v1/action_log**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          {
            id: 'log-1',
            table_name: 'items',
            operation: 'INSERT',
            row_id: 'item-1',
            user_id: 'demo-u1',
            old_data: null,
            new_data: { name: 'Bolt' },
            created_at: '2026-01-15T10:00:00Z',
            user: { id: 'demo-u1', name: 'Admin User', email: 'admin@example.com' },
          },
        ]),
      })
    );

    await page.goto('/?demoRole=admin#/action-log');
    const downloadPromise = page.waitForEvent('download');
    await page.click('[data-action="export-csv"]');
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/^action-log-.*\.csv$/);
  });

  test('shows an empty state when no actions match', async ({ page }) => {
    await page.route('**/rest/v1/rpc/admin_list_users**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    await page.route('**/rest/v1/action_log**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));

    await page.goto('/?demoRole=admin#/action-log');
    await expect(page.locator('[data-screen="action-log"]')).toContainText('No actions match these filters.');
  });
});
