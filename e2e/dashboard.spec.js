// Dashboard: real KPI cards + recent-activity feed, replacing the Phase 0
// placeholder (direct user report: the Dashboard still showed nothing).
// Network-mocked against demo mode, same approach as phase0-11. Every
// widget reuses an existing module's own read (available_stock,
// purchase_orders, etc.) gated by the same canViewModule() check the
// sidebar uses — these tests mock exactly the endpoints each role's set
// of widgets should (and shouldn't) call.
import { test, expect } from '@playwright/test';

function mockAdminWidgetData(page) {
  return Promise.all([
    page.route('**/rest/v1/items**', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ id: 'i1', name: 'Widget', category: null, unit_of_measure: 'Nos.', reorder_level: null, deleted_at: null }]) })
    ),
    page.route('**/rest/v1/available_stock**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          { item_id: 'i1', name: 'Widget', current_qty: 5, reserved_qty: 0, available_qty: 5, reorder_level: 10 },
          { item_id: 'i2', name: 'Bolt', current_qty: 500, reserved_qty: 0, available_qty: 500, reorder_level: null },
        ]),
      })
    ),
    page.route('**/rest/v1/purchase_orders**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          { id: 'po1', status: 'to_be_received', deleted_at: null },
          { id: 'po2', status: 'partially_received', deleted_at: null },
          { id: 'po3', status: 'received_inspected', deleted_at: null },
        ]),
      })
    ),
    page.route('**/rest/v1/material_inward_line_items**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          { id: 'mil1', inward: { deleted_at: null }, inspection_results: [] },
          { id: 'mil2', inward: { deleted_at: null }, inspection_results: [{ id: 'ir1' }] },
        ]),
      })
    ),
    page.route('**/rest/v1/work_orders**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          { id: 'wo1', status: 'open' },
          { id: 'wo2', status: 'reserved' },
          { id: 'wo3', status: 'completed' },
        ]),
      })
    ),
    page.route('**/rest/v1/work_order_requirements**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([{ id: 'req1', shortfall_qty: 4, item: { name: 'Bolt' }, work_order: { status: 'open' } }]),
      })
    ),
    page.route('**/rest/v1/invoices**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          { id: 'inv1', due_date: '2020-01-01', paid_at: null, deleted_at: null },
          { id: 'inv2', due_date: '2099-01-01', paid_at: null, deleted_at: null },
        ]),
      })
    ),
    page.route('**/rest/v1/material_dispatch**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          { id: 'md1', authorized_at: null },
          { id: 'md2', authorized_at: '2026-01-01T00:00:00Z' },
        ]),
      })
    ),
    page.route('**/rest/v1/action_log**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          { id: 'log1', table_name: 'work_orders', operation: 'UPDATE', user: { name: 'Demo Production' }, created_at: '2026-01-15T10:00:00Z' },
        ]),
      })
    ),
  ]);
}

test.describe('Dashboard — role-scoped KPI widgets', () => {
  test('admin sees every widget with the right counts, plus recent activity', async ({ page }) => {
    await mockAdminWidgetData(page);

    await page.goto('/?demoRole=admin#/dashboard');
    await expect(page.locator('[data-screen="dashboard"]')).toBeVisible();
    await expect(page.locator('[data-role="dashboard-widgets"]')).toBeVisible();

    await expect(page.locator('[data-dashboard-widget="below-reorder"]')).toContainText('1');
    await expect(page.locator('[data-dashboard-widget="open-pos"]')).toContainText('2');
    await expect(page.locator('[data-dashboard-widget="pending-inspection"]')).toContainText('1');
    await expect(page.locator('[data-dashboard-widget="active-work-orders"]')).toContainText('2');
    await expect(page.locator('[data-dashboard-widget="shortages"]')).toContainText('1');
    await expect(page.locator('[data-dashboard-widget="overdue-invoices"]')).toContainText('1');
    await expect(page.locator('[data-dashboard-widget="pending-dispatch"]')).toContainText('1');

    await expect(page.locator('[data-role="dashboard-activity"]')).toContainText('Work Order Updated');
    await expect(page.locator('[data-role="dashboard-activity"]')).toContainText('Demo Production');
  });

  test('a widget card links to its own screen', async ({ page }) => {
    await mockAdminWidgetData(page);

    await page.goto('/?demoRole=admin#/dashboard');
    await page.click('[data-dashboard-widget="below-reorder"]');
    await expect(page.locator('[data-screen="inventory"]')).toBeVisible();
  });

  test('store sees only store-relevant widgets, and no admin-only recent activity', async ({ page }) => {
    await page.route('**/rest/v1/items**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    await page.route('**/rest/v1/available_stock**', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ item_id: 'i1', name: 'Widget', current_qty: 5, reserved_qty: 0, available_qty: 5, reorder_level: 10 }]) })
    );
    await page.route('**/rest/v1/work_orders**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ id: 'wo1', status: 'open' }]) }));
    await page.route('**/rest/v1/work_order_requirements**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    await page.route('**/rest/v1/material_dispatch**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ id: 'md1', authorized_at: null }]) }));

    let hitInvoices = false;
    let hitActionLog = false;
    await page.route('**/rest/v1/invoices**', (route) => {
      hitInvoices = true;
      route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
    });
    await page.route('**/rest/v1/action_log**', (route) => {
      hitActionLog = true;
      route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
    });

    await page.goto('/?demoRole=store#/dashboard');
    await expect(page.locator('[data-screen="dashboard"]')).toBeVisible();

    await expect(page.locator('[data-dashboard-widget="below-reorder"]')).toBeVisible();
    await expect(page.locator('[data-dashboard-widget="active-work-orders"]')).toBeVisible();
    await expect(page.locator('[data-dashboard-widget="shortages"]')).toBeVisible();
    await expect(page.locator('[data-dashboard-widget="pending-dispatch"]')).toBeVisible();

    await expect(page.locator('[data-dashboard-widget="open-pos"]')).toHaveCount(0);
    await expect(page.locator('[data-dashboard-widget="pending-inspection"]')).toHaveCount(0);
    await expect(page.locator('[data-dashboard-widget="overdue-invoices"]')).toHaveCount(0);
    await expect(page.locator('[data-role="dashboard-activity"]')).toHaveCount(0);
    expect(hitInvoices).toBe(false);
    expect(hitActionLog).toBe(false);
  });

  test('a role with no widget-eligible modules sees a friendly empty state instead of nothing', async ({ page }) => {
    await page.route('**/auth/v1/token**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          access_token: 'fake-token',
          token_type: 'bearer',
          expires_in: 3600,
          expires_at: Math.floor(Date.now() / 1000) + 3600,
          refresh_token: 'fake-refresh',
          user: { id: 'norole-1', email: 'norole@example.com' },
        }),
      })
    );
    await page.route('**/rest/v1/users**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ id: 'norole-1', name: 'New Employee', email: 'norole@example.com', role: null, status: 'active' }),
      })
    );

    await page.goto('/#/login');
    await page.fill('#signin-email', 'norole@example.com');
    await page.fill('#signin-password', 'secret1');
    await page.click('[data-form="signin"] button[type="submit"]');

    await expect(page.locator('[data-screen="dashboard"]')).toBeVisible();
    await expect(page.locator('[data-role="dashboard-widgets"]')).toHaveCount(0);
    await expect(page.locator('[data-role="dashboard-activity"]')).toHaveCount(0);
    await expect(page.locator('[data-screen="dashboard"]')).toContainText("doesn't have any modules with quick stats yet");
  });

  test('one widget failing to load shows — instead of breaking the whole dashboard', async ({ page }) => {
    await mockAdminWidgetData(page);
    await page.unroute('**/rest/v1/invoices**');
    await page.route('**/rest/v1/invoices**', (route) => route.fulfill({ status: 500, contentType: 'application/json', body: '{"message":"boom"}' }));

    await page.goto('/?demoRole=admin#/dashboard');
    await expect(page.locator('[data-dashboard-widget="overdue-invoices"]')).toContainText('—');
    // Every other widget still loaded normally despite the one failure.
    await expect(page.locator('[data-dashboard-widget="below-reorder"]')).toContainText('1');
    await expect(page.locator('[data-role="dashboard-activity"]')).toBeVisible();
  });
});
