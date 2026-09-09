// Roles & Rights (direct request addendum): a role x permission matrix,
// editable by an admin, backed by supabase/schema.sql's role_permissions
// table and admin_set_role_permission() RPC. Real RLS/RPC enforcement
// (non-admin blocked, admin can't target 'admin', a grant/revoke actually
// changes what the underlying RLS policy allows) is covered separately by
// scripts/test-rls-role-permissions.mjs against a real database.
import { test, expect } from '@playwright/test';

const SEED_ROWS = [
  { role: 'purchase', permission: 'manage_purchasing' },
  { role: 'store', permission: 'manage_store_operations' },
  { role: 'inspector', permission: 'manage_inspections' },
  { role: 'purchase', permission: 'manage_items' },
  { role: 'store', permission: 'manage_items' },
  { role: 'authorized', permission: 'manage_finance' },
  { role: 'production', permission: 'manage_boms' },
  { role: 'production', permission: 'manage_work_orders' },
  { role: 'store', permission: 'manage_work_orders' },
];

test.describe('Roles & Rights — route guard', () => {
  test('a non-admin navigating directly to #/roles-and-rights is redirected to the dashboard', async ({ page }) => {
    await page.goto('/?demoRole=store#/roles-and-rights');
    await expect(page).toHaveURL(/#\/dashboard$/);
  });

  test('the sidebar link only appears for admin', async ({ page }) => {
    await page.goto('/?demoRole=store#/dashboard');
    await expect(page.locator('[data-nav="/roles-and-rights"]')).toHaveCount(0);

    await page.goto('/?demoRole=admin#/dashboard');
    await expect(page.locator('[data-nav="/roles-and-rights"]').first()).toBeVisible();
  });
});

// Reported directly: a purchase-role user granted the Finance right from
// Roles & Rights still couldn't see Invoices at all — navPermissions.js's
// MODULE_ROLES was the *only* thing deciding nav visibility, entirely
// separate from the write-permission check Invoices' own RLS enforces, so
// granting the right and seeing its screen could go out of sync. Fixed by
// having canViewModule also consult MODULE_PERMISSIONS/role_permissions —
// this covers the reported scenario end to end: sidebar link, direct nav,
// and the deliberate Bill Payments exception all still holding.
test.describe('Roles & Rights — a granted right reveals its screen (reported bug)', () => {
  test('purchase without the Finance right sees neither the Invoices link nor the screen', async ({ page }) => {
    await page.route('**/rest/v1/role_permissions**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));

    await page.goto('/?demoRole=purchase#/dashboard');
    await expect(page.locator('[data-nav="/invoices"]')).toHaveCount(0);

    await page.goto('/?demoRole=purchase#/invoices');
    await expect(page).toHaveURL(/#\/dashboard$/);
  });

  test('granting purchase the Finance right shows the Invoices link, and the screen actually loads', async ({ page }) => {
    await page.route('**/rest/v1/role_permissions**', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ role: 'purchase', permission: 'manage_finance' }]) })
    );
    await page.route('**/rest/v1/vendors**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    await page.route('**/rest/v1/purchase_orders**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    await page.route('**/rest/v1/invoices**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));

    await page.goto('/?demoRole=purchase#/dashboard');
    await expect(page.locator('[data-nav="/invoices"]').first()).toBeVisible();

    await page.goto('/?demoRole=purchase#/invoices');
    await expect(page).toHaveURL(/#\/invoices$/);
    await expect(page.locator('[data-screen="invoices"]')).toBeVisible();
  });

  test("granting purchase the Finance right does NOT reveal Bill Payments — that exception holds even end to end", async ({ page }) => {
    await page.route('**/rest/v1/role_permissions**', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ role: 'purchase', permission: 'manage_finance' }]) })
    );

    await page.goto('/?demoRole=purchase#/dashboard');
    await expect(page.locator('[data-nav="/bill-payments"]')).toHaveCount(0);

    await page.goto('/?demoRole=purchase#/bill-payments');
    await expect(page).toHaveURL(/#\/dashboard$/);
  });

  test('granting purchase the Item Master right reveals both Inventory and Price History', async ({ page }) => {
    await page.route('**/rest/v1/role_permissions**', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ role: 'purchase', permission: 'manage_items' }]) })
    );

    await page.goto('/?demoRole=purchase#/dashboard');
    await expect(page.locator('[data-nav="/inventory"]').first()).toBeVisible();
    await expect(page.locator('[data-nav="/price-history"]').first()).toBeVisible();
  });
});

test.describe('Roles & Rights — matrix', () => {
  test('renders the seeded permissions, with Admin always checked and disabled', async ({ page }) => {
    await page.route('**/rest/v1/role_permissions**', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(SEED_ROWS) })
    );

    await page.goto('/?demoRole=admin#/roles-and-rights');
    await expect(page.locator('[data-screen="roles-and-rights"]')).toBeVisible();

    const purchasingRow = page.locator('[data-permission-row="manage_purchasing"]');
    await expect(purchasingRow.locator('[data-role="purchase"]')).toBeChecked();
    await expect(purchasingRow.locator('[data-role="store"]')).not.toBeChecked();
    await expect(purchasingRow.locator('input[disabled]')).toBeChecked();

    const itemsRow = page.locator('[data-permission-row="manage_items"]');
    await expect(itemsRow.locator('[data-role="purchase"]')).toBeChecked();
    await expect(itemsRow.locator('[data-role="store"]')).toBeChecked();
    await expect(itemsRow.locator('[data-role="inspector"]')).not.toBeChecked();
  });

  test('shows an empty-but-valid matrix (every box unchecked except Admin) when no permissions are granted yet', async ({ page }) => {
    await page.route('**/rest/v1/role_permissions**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));

    await page.goto('/?demoRole=admin#/roles-and-rights');
    await expect(page.locator('[data-permission-row="manage_items"] [data-role="purchase"]')).not.toBeChecked();
  });

  test('granting a permission checks the box and calls admin_set_role_permission with granted: true', async ({ page }) => {
    let callCount = 0;
    await page.route('**/rest/v1/role_permissions**', (route) => {
      callCount += 1;
      const body = callCount === 1 ? SEED_ROWS : [...SEED_ROWS, { role: 'inspector', permission: 'manage_items' }];
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    });
    let rpcBody = null;
    await page.route('**/rest/v1/rpc/admin_set_role_permission**', (route) => {
      rpcBody = route.request().postDataJSON();
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    });

    await page.goto('/?demoRole=admin#/roles-and-rights');
    const checkbox = page.locator('[data-permission-row="manage_items"] [data-role="inspector"]');
    await expect(checkbox).not.toBeChecked();
    await checkbox.click();

    expect(rpcBody).toEqual({ target_role: 'inspector', target_permission: 'manage_items', granted: true });
    await expect(checkbox).toBeChecked();
  });

  test('revoking a permission unchecks the box and calls admin_set_role_permission with granted: false', async ({ page }) => {
    let callCount = 0;
    await page.route('**/rest/v1/role_permissions**', (route) => {
      callCount += 1;
      const body = callCount === 1 ? SEED_ROWS : SEED_ROWS.filter((r) => !(r.role === 'purchase' && r.permission === 'manage_purchasing'));
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    });
    let rpcBody = null;
    await page.route('**/rest/v1/rpc/admin_set_role_permission**', (route) => {
      rpcBody = route.request().postDataJSON();
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    });

    await page.goto('/?demoRole=admin#/roles-and-rights');
    const checkbox = page.locator('[data-permission-row="manage_purchasing"] [data-role="purchase"]');
    await expect(checkbox).toBeChecked();
    await checkbox.click();

    expect(rpcBody).toEqual({ target_role: 'purchase', target_permission: 'manage_purchasing', granted: false });
    await expect(checkbox).not.toBeChecked();
  });

  test('a failed toggle shows an alert and reverts the checkbox to its previous state', async ({ page }) => {
    await page.route('**/rest/v1/role_permissions**', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(SEED_ROWS) })
    );
    await page.route('**/rest/v1/rpc/admin_set_role_permission**', (route) =>
      route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ message: 'Only an admin can edit role permissions.' }) })
    );

    let alertMessage = '';
    page.on('dialog', (dialog) => {
      alertMessage = dialog.message();
      dialog.accept();
    });

    await page.goto('/?demoRole=admin#/roles-and-rights');
    const checkbox = page.locator('[data-permission-row="manage_items"] [data-role="inspector"]');
    await expect(checkbox).not.toBeChecked();
    await checkbox.click();

    await expect.poll(() => alertMessage).not.toBe('');
    await expect(checkbox).not.toBeChecked();
    await expect(checkbox).toBeEnabled();
  });

  test('shows an empty-state retry when role_permissions fails to load', async ({ page }) => {
    await page.route('**/rest/v1/role_permissions**', (route) => route.fulfill({ status: 500, contentType: 'application/json', body: '{}' }));

    await page.goto('/?demoRole=admin#/roles-and-rights');
    await expect(page.locator('[data-screen="roles-and-rights"]')).toContainText("Couldn't load role permissions");
    await expect(page.locator('[data-action="retry"]')).toBeVisible();
  });
});
