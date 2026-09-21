// Phase 11 — Material Dispatch. Network-mocked against demo mode, same
// approach as phase0-10. Real RLS/RPC behavior (including the atomic
// stock-shortfall check in authorize_material_dispatch(), and that the
// table has no direct update policy at all) is covered by
// scripts/test-rls-material-dispatch.mjs against a real database.
//
// Phase 13 addendum: payment tracking (and its "mark payment received"
// flow) moved off this screen entirely, onto the admin-only Delivery
// Challans screen — see e2e/deliveryChallans.spec.js for that coverage.
import { test, expect } from '@playwright/test';

const DEFAULT_ROLE_PERMISSIONS = [
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
// Roles & Rights addendum: every screen with its own manage/create action
// now fetches role_permissions alongside its other data (see e.g.
// inventory.js's load()) to decide button visibility dynamically instead
// of a hardcoded role check — every test needs this mocked to the same
// default seed schema.sql ships, or the relevant button never appears.
function mockDefaultRolePermissions(page) {
  return page.route('**/rest/v1/role_permissions**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(DEFAULT_ROLE_PERMISSIONS) })
  );
}

const ITEMS = [{ id: 'item-widget', name: 'Widget', category: null, unit_of_measure: 'Nos.', reorder_level: null, deleted_at: null }];

function mockItems(page) {
  return page.route('**/rest/v1/items**', (route) => {
    if (route.request().method() === 'GET') {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(ITEMS) });
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
  });
}

function mockCurrentRates(page) {
  return page.route('**/rest/v1/item_current_rate**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
}

test.describe('Phase 11 — route guards', () => {
  test('a role without Material Dispatch access is redirected to the dashboard', async ({ page }) => {
    await mockDefaultRolePermissions(page);
    await page.goto('/?demoRole=authorized#/material-dispatch');
    await expect(page).toHaveURL(/#\/dashboard$/);
  });
});

test.describe('Phase 11 — Material Dispatch — create', () => {
  test('creates a dispatch record by manual entry (no stock deducted, awaiting authorization)', async ({ page }) => {
    await mockDefaultRolePermissions(page);
    await mockItems(page);
    await mockCurrentRates(page);

    let dispatchInsertBody = null;
    let lineItemsInsertBody = null;
    await page.route('**/rest/v1/material_dispatch*', (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith('/material_dispatch_line_items')) {
        lineItemsInsertBody = route.request().postDataJSON();
        return route.fulfill({ status: 201, contentType: 'application/json', body: '[]' });
      }
      if (route.request().method() === 'POST') {
        dispatchInsertBody = route.request().postDataJSON();
        return route.fulfill({
          status: 201,
          contentType: 'application/json',
          body: JSON.stringify({ id: 'dispatch-1', dispatch_date: dispatchInsertBody.dispatch_date }),
        });
      }
      return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
    });

    await page.goto('/?demoRole=store#/material-dispatch');
    await expect(page.locator('[data-screen="material-dispatch"]')).toBeVisible();
    await page.click('[data-action="new-dispatch"]');

    await page.fill('[data-action="form-dc-number"]', 'DC-1001');
    await page.fill('[data-action="form-party"]', 'Acme Corp');
    await page.selectOption('[data-action="line-item"]', 'item-widget');
    await page.fill('[data-action="line-quantity"]', '5');
    await page.fill('[data-action="line-rate"]', '25');
    await page.click('[data-action="save-dispatch"]');

    await expect(page.locator('[data-role="dispatch-form"]')).toHaveCount(0);
    expect(dispatchInsertBody).toMatchObject({
      dc_number: 'DC-1001',
      reference: 'Acme Corp',
      notes: null,
      client_po_number: null,
      our_invoice_number: null,
      gst_percent: 18,
      created_by: 'demo-u3',
    });
    expect(lineItemsInsertBody).toEqual([{ dispatch_id: 'dispatch-1', item_id: 'item-widget', quantity: 5, rate: 25 }]);
  });

  test('saving without a DC No., Party, or any item shows an error and never calls Supabase', async ({ page }) => {
    await mockDefaultRolePermissions(page);
    await mockItems(page);
    await mockCurrentRates(page);
    let insertCalled = false;
    await page.route('**/rest/v1/material_dispatch*', (route) => {
      if (route.request().method() === 'POST') insertCalled = true;
      route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
    });

    await page.goto('/?demoRole=admin#/material-dispatch');
    await page.click('[data-action="new-dispatch"]');
    await page.click('[data-action="save-dispatch"]');

    await expect(page.locator('[data-role="form-error"]')).toBeVisible();
    expect(insertCalled).toBe(false);
  });

  test('only admin sees the PO No. (Client) field', async ({ page }) => {
    await mockDefaultRolePermissions(page);
    await mockItems(page);
    await mockCurrentRates(page);
    await page.route('**/rest/v1/material_dispatch**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));

    await page.goto('/?demoRole=store#/material-dispatch');
    await page.click('[data-action="new-dispatch"]');
    await expect(page.locator('[data-action="form-client-po"]')).toHaveCount(0);

    await page.goto('/?demoRole=admin#/material-dispatch');
    await page.click('[data-action="new-dispatch"]');
    await expect(page.locator('[data-action="form-client-po"]')).toBeVisible();
  });

  test('uploading a non-PDF delivery challan that OCR cannot read falls back to manual entry', async ({ page }) => {
    await mockDefaultRolePermissions(page);
    // Same reasoning as Material Inward's own equivalent test: a file whose
    // type isn't application/pdf skips PDF text extraction, and since it
    // isn't a real image either, the OCR fallback also comes up empty.
    await mockItems(page);
    await mockCurrentRates(page);
    await page.route('**/rest/v1/material_dispatch**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));

    await page.goto('/?demoRole=store#/material-dispatch');
    await page.click('[data-action="new-dispatch"]');

    await page.setInputFiles('#md-challan-file', {
      name: 'scanned-challan.png',
      mimeType: 'image/png',
      buffer: Buffer.from('not a real png, just a placeholder for a scanned image'),
    });

    await expect(page.locator('[data-role="challan-parse-note"]')).toContainText('enter items by hand', { timeout: 30000 });
    await expect(page.locator('text=Selected: scanned-challan.png')).toBeVisible();
  });
});

test.describe('Phase 11 — Material Dispatch — admin authorization', () => {
  const DISPATCH_UNAUTHORIZED = {
    id: 'dispatch-1',
    dispatch_date: '2026-01-15',
    dc_number: 'DC-1001',
    reference: 'Acme Corp',
    notes: null,
    client_po_number: null,
    our_invoice_number: null,
    gst_percent: 18,
    challan_file_path: null,
    challan_file_name: null,
    authorized_by: null,
    authorized_at: null,
    payment_received_by: null,
    payment_received_at: null,
    payment_date: null,
    line_items: [{ id: 'li-1', item_id: 'item-widget', quantity: 5, rate: 25, item: { id: 'item-widget', name: 'Widget', unit_of_measure: 'Nos.' } }],
  };

  test('store role sees a dispatch pending authorization but no Authorize button', async ({ page }) => {
    await mockDefaultRolePermissions(page);
    await mockItems(page);
    await mockCurrentRates(page);
    await page.route('**/rest/v1/material_dispatch**', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([DISPATCH_UNAUTHORIZED]) })
    );

    await page.goto('/?demoRole=store#/material-dispatch');
    await expect(page.locator('[data-dispatch-row="dispatch-1"]')).toContainText('Pending Authorization');
    await expect(page.locator('[data-dispatch-row="dispatch-1"] [data-action="authorize-dispatch"]')).toHaveCount(0);
  });

  test('shows Final Amount (Total Amount with GST) for each dispatch', async ({ page }) => {
    await mockDefaultRolePermissions(page);
    await mockItems(page);
    await mockCurrentRates(page);
    // 5 x 25 = 125 total, +18% GST = 147.50
    await page.route('**/rest/v1/material_dispatch**', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([DISPATCH_UNAUTHORIZED]) })
    );

    await page.goto('/?demoRole=admin#/material-dispatch');
    await expect(page.locator('[data-dispatch-row="dispatch-1"] [data-role="dispatch-final-amount"]')).toContainText('147.50');
  });

  test('admin authorizes a dispatch, deducting inventory server-side', async ({ page }) => {
    await mockDefaultRolePermissions(page);
    await mockItems(page);
    await mockCurrentRates(page);
    let requestCount = 0;
    await page.route('**/rest/v1/material_dispatch**', (route) => {
      requestCount += 1;
      const body = requestCount === 1 ? DISPATCH_UNAUTHORIZED : { ...DISPATCH_UNAUTHORIZED, authorized_by: 'admin-1', authorized_at: '2026-01-16T00:00:00Z' };
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([body]) });
    });

    let authorizeBody = null;
    await page.route('**/rest/v1/rpc/authorize_material_dispatch**', (route) => {
      authorizeBody = route.request().postDataJSON();
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    });

    page.once('dialog', (dialog) => dialog.accept());
    await page.goto('/?demoRole=admin#/material-dispatch');
    await expect(page.locator('[data-dispatch-row="dispatch-1"]')).toContainText('Pending Authorization');
    await page.click('[data-dispatch-row="dispatch-1"] [data-action="authorize-dispatch"]');

    expect(authorizeBody).toEqual({ target_dispatch_id: 'dispatch-1' });
    await expect(page.locator('[data-dispatch-row="dispatch-1"] [data-role="dispatch-status"]')).toContainText('Authorized');
    await expect(page.locator('[data-dispatch-row="dispatch-1"] [data-action="authorize-dispatch"]')).toHaveCount(0);
  });

  test('shows the server-side shortfall message when authorization is blocked', async ({ page }) => {
    await mockDefaultRolePermissions(page);
    await mockItems(page);
    await mockCurrentRates(page);
    await page.route('**/rest/v1/material_dispatch**', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([DISPATCH_UNAUTHORIZED]) })
    );
    await page.route('**/rest/v1/rpc/authorize_material_dispatch**', (route) =>
      route.fulfill({
        status: 400,
        contentType: 'application/json',
        body: JSON.stringify({ message: 'Cannot authorize — stock is insufficient: Widget (need 5, have 2 available); ' }),
      })
    );

    page.once('dialog', (dialog) => dialog.accept());
    await page.goto('/?demoRole=admin#/material-dispatch');
    await page.click('[data-dispatch-row="dispatch-1"] [data-action="authorize-dispatch"]');
    await page.click('[data-action="toggle-dispatch"][data-id="dispatch-1"]');

    await expect(page.locator('[data-role="authorize-error"]')).toContainText('Cannot authorize');
  });
});
