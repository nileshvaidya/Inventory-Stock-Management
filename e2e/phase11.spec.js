// Phase 11 — Material Dispatch. Network-mocked against demo mode, same
// approach as phase0-10. Real RLS/RPC behavior (including the atomic
// stock-shortfall check in authorize_material_dispatch(), and that the
// table has no direct update policy at all) is covered by
// scripts/test-rls-material-dispatch.mjs against a real database.
import { test, expect } from '@playwright/test';

const ITEMS = [{ id: 'item-widget', name: 'Widget', category: null, unit_of_measure: 'Nos.', reorder_level: null, deleted_at: null }];

function mockItems(page) {
  return page.route('**/rest/v1/items**', (route) => {
    if (route.request().method() === 'GET') {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(ITEMS) });
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
  });
}

test.describe('Phase 11 — route guards', () => {
  test('a role without Material Dispatch access is redirected to the dashboard', async ({ page }) => {
    await page.goto('/?demoRole=authorized#/material-dispatch');
    await expect(page).toHaveURL(/#\/dashboard$/);
  });
});

test.describe('Phase 11 — Material Dispatch — create', () => {
  test('creates a dispatch record by manual entry (no stock deducted, awaiting authorization)', async ({ page }) => {
    await mockItems(page);

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

    await page.selectOption('[data-action="line-item"]', 'item-widget');
    await page.fill('[data-action="line-quantity"]', '5');
    await page.click('[data-action="save-dispatch"]');

    await expect(page.locator('[data-role="dispatch-form"]')).toHaveCount(0);
    expect(dispatchInsertBody).toMatchObject({ reference: null, notes: null, created_by: 'demo-u3' });
    expect(lineItemsInsertBody).toEqual([{ dispatch_id: 'dispatch-1', item_id: 'item-widget', quantity: 5 }]);
  });

  test('saving without picking an item shows an error and never calls Supabase', async ({ page }) => {
    await mockItems(page);
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

  test('uploading a non-PDF delivery challan that OCR cannot read falls back to manual entry', async ({ page }) => {
    // Same reasoning as Material Inward's own equivalent test: a file whose
    // type isn't application/pdf skips PDF text extraction, and since it
    // isn't a real image either, the OCR fallback also comes up empty.
    await mockItems(page);
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

test.describe('Phase 11 — Material Dispatch — admin authorization & payment', () => {
  const DISPATCH_UNAUTHORIZED = {
    id: 'dispatch-1',
    dispatch_date: '2026-01-15',
    reference: 'Site A',
    notes: null,
    challan_file_path: null,
    challan_file_name: null,
    authorized_by: null,
    authorized_at: null,
    payment_received_by: null,
    payment_received_at: null,
    line_items: [{ id: 'li-1', item_id: 'item-widget', quantity: 5, item: { id: 'item-widget', name: 'Widget', unit_of_measure: 'Nos.' } }],
  };

  test('store role sees a dispatch pending authorization but no Authorize button or Payment column', async ({ page }) => {
    await mockItems(page);
    await page.route('**/rest/v1/material_dispatch**', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([DISPATCH_UNAUTHORIZED]) })
    );

    await page.goto('/?demoRole=store#/material-dispatch');
    await expect(page.locator('[data-dispatch-row="dispatch-1"]')).toContainText('Pending Authorization');
    await expect(page.locator('[data-dispatch-row="dispatch-1"] [data-action="authorize-dispatch"]')).toHaveCount(0);
    await expect(page.locator('[data-role="payment-cell"]')).toHaveCount(0);
  });

  test('admin authorizes a dispatch, deducting inventory server-side', async ({ page }) => {
    await mockItems(page);
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
    await mockItems(page);
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

  test('admin marks payment received on an authorized dispatch; the button and field are admin-only', async ({ page }) => {
    await mockItems(page);
    const AUTHORIZED = { ...DISPATCH_UNAUTHORIZED, authorized_by: 'admin-1', authorized_at: '2026-01-16T00:00:00Z' };
    let requestCount = 0;
    await page.route('**/rest/v1/material_dispatch**', (route) => {
      requestCount += 1;
      const body = requestCount === 1 ? AUTHORIZED : { ...AUTHORIZED, payment_received_by: 'admin-1', payment_received_at: '2026-01-20T00:00:00Z' };
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([body]) });
    });

    let paymentBody = null;
    await page.route('**/rest/v1/rpc/mark_dispatch_payment_received**', (route) => {
      paymentBody = route.request().postDataJSON();
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    });

    await page.goto('/?demoRole=admin#/material-dispatch');
    await expect(page.locator('[data-role="payment-cell"]')).toContainText('Mark Payment Received');
    await page.click('[data-action="mark-payment"][data-id="dispatch-1"]');

    expect(paymentBody).toEqual({ target_dispatch_id: 'dispatch-1' });
    await expect(page.locator('[data-role="payment-cell"]')).toContainText('Received');
  });

  test('store role never sees the Payment column, even on an authorized dispatch', async ({ page }) => {
    await mockItems(page);
    const AUTHORIZED = { ...DISPATCH_UNAUTHORIZED, authorized_by: 'admin-1', authorized_at: '2026-01-16T00:00:00Z' };
    await page.route('**/rest/v1/material_dispatch**', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([AUTHORIZED]) })
    );

    await page.goto('/?demoRole=store#/material-dispatch');
    await expect(page.locator('[data-dispatch-row="dispatch-1"]')).toContainText('Authorized');
    await expect(page.locator('[data-role="payment-cell"]')).toHaveCount(0);
  });
});
