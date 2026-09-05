// Phase 3 — Material Inward, Inspection, Master Material Status. Network-
// mocked against demo mode, same approach as phase0-2. Real RLS/RPC
// behavior (including the recompute_po_status triggers) is covered by
// scripts/test-rls-material-inward.mjs against a real database.
import { test, expect } from '@playwright/test';

test.describe('Phase 3 — route guards', () => {
  test('a non-store role navigating to #/material-inward is redirected to the dashboard', async ({ page }) => {
    await page.goto('/?demoRole=authorized#/material-inward');
    await expect(page).toHaveURL(/#\/dashboard$/);
  });

  test('a non-inspector role navigating to #/inspection is redirected to the dashboard', async ({ page }) => {
    await page.goto('/?demoRole=store#/inspection');
    await expect(page).toHaveURL(/#\/dashboard$/);
  });

  test('a role without Master Material Status access is redirected to the dashboard', async ({ page }) => {
    await page.goto('/?demoRole=authorized#/master-material-status');
    await expect(page).toHaveURL(/#\/dashboard$/);
  });
});

test.describe('Phase 3 — Material Inward', () => {
  test('logs a receipt against a PO and shows a success message', async ({ page }) => {
    await page.route('**/rest/v1/purchase_orders**', (route) => {
      if (route.request().method() === 'GET') {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify([
            {
              id: 'po-1',
              po_number: 'PO-1001',
              status: 'to_be_received',
              deleted_at: null,
              project: { id: 'p1', name: 'Bridge Build' },
              vendor: { id: 'v1', name: 'Acme' },
            },
          ]),
        });
      }
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    });

    await page.route('**/rest/v1/master_material_status**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          {
            po_line_item_id: 'pli-1',
            po_id: 'po-1',
            po_number: 'PO-1001',
            project_name: 'Bridge Build',
            vendor_name: 'Acme',
            item_name: 'Base Angle',
            ordered_qty: 1500,
            received_qty: 0,
            accepted_qty: 0,
            rejected_qty: 0,
            pending_qty: 1500,
            po_status: 'to_be_received',
          },
        ]),
      })
    );

    let inwardLineItemsInsertBody = null;
    await page.route('**/rest/v1/material_inward*', (route) => {
      // Checking the whole URL (as opposed to just its path) is wrong here:
      // fetchInwardHistory's GET against the plain material_inward table
      // embeds "line_items:material_inward_line_items(...)" in its own
      // ?select= query param, so a substring check on the full URL matches
      // that GET too — intermittently clobbering the captured POST body
      // with null (postDataJSON() on a GET) depending on exactly when that
      // background refresh's request lands relative to this assertion.
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith('/material_inward_line_items')) {
        inwardLineItemsInsertBody = route.request().postDataJSON();
        return route.fulfill({ status: 201, contentType: 'application/json', body: '[]' });
      }
      if (route.request().method() === 'POST') {
        return route.fulfill({
          status: 201,
          contentType: 'application/json',
          body: JSON.stringify({ id: 'inward-1', po_id: 'po-1', received_date: '2026-01-15', notes: null }),
        });
      }
      return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
    });

    await page.goto('/?demoRole=store#/material-inward');
    await expect(page.locator('[data-screen="material-inward"]')).toBeVisible();
    await page.selectOption('[data-action="select-po"]', 'po-1');
    await expect(page.locator('[data-inward-row="pli-1"]')).toBeVisible();

    await page.fill('[data-action="received-qty"][data-po-line-item-id="pli-1"]', '500');
    await page.click('[data-action="save"]');

    await expect(page.locator('text=Receipt logged.')).toBeVisible();
    expect(inwardLineItemsInsertBody).toEqual([{ inward_id: 'inward-1', po_line_item_id: 'pli-1', received_qty: 500 }]);
  });

  test('rejects a received quantity greater than what is pending, without saving', async ({ page }) => {
    await page.route('**/rest/v1/purchase_orders**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          { id: 'po-1', po_number: 'PO-1001', status: 'to_be_received', deleted_at: null, project: { id: 'p1', name: 'Bridge Build' }, vendor: null },
        ]),
      })
    );
    await page.route('**/rest/v1/master_material_status**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          {
            po_line_item_id: 'pli-1',
            po_id: 'po-1',
            item_name: 'Base Angle',
            ordered_qty: 100,
            received_qty: 0,
            accepted_qty: 0,
            rejected_qty: 0,
            pending_qty: 100,
            po_status: 'to_be_received',
          },
        ]),
      })
    );
    let insertCalled = false;
    await page.route('**/rest/v1/material_inward*', (route) => {
      // Selecting the PO fires a GET for inward history regardless of what
      // happens next — only a POST here would mean the (invalid) form was
      // actually submitted.
      if (route.request().method() === 'POST') insertCalled = true;
      route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
    });

    await page.goto('/?demoRole=store#/material-inward');
    await page.selectOption('[data-action="select-po"]', 'po-1');
    await expect(page.locator('[data-inward-row="pli-1"]')).toBeVisible();

    await page.fill('[data-action="received-qty"][data-po-line-item-id="pli-1"]', '999');
    await page.click('[data-action="save"]');

    await expect(page.locator('[data-role="save-error"]')).toBeVisible();
    expect(insertCalled).toBe(false);
  });

  test('uploading a non-PDF delivery challan attaches it without attempting to auto-fill quantities', async ({ page }) => {
    // Real PDF parsing (extractPdfText + parseChallanText + matching by
    // item name) is covered by src/pdfParser.test.js's own unit tests
    // (pure logic, no PDF binary fixture needed here) — same convention as
    // PO Upload's e2e suite. This test only needs a file whose type isn't
    // application/pdf, which Playwright can synthesize in-memory.
    await page.route('**/rest/v1/purchase_orders**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          { id: 'po-1', po_number: 'PO-1001', status: 'to_be_received', deleted_at: null, project: { id: 'p1', name: 'Bridge Build' }, vendor: null },
        ]),
      })
    );
    await page.route('**/rest/v1/master_material_status**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          {
            po_line_item_id: 'pli-1',
            po_id: 'po-1',
            item_name: 'Base Angle',
            ordered_qty: 100,
            received_qty: 0,
            accepted_qty: 0,
            rejected_qty: 0,
            pending_qty: 100,
            po_status: 'to_be_received',
          },
        ]),
      })
    );
    await page.route('**/rest/v1/material_inward*', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));

    await page.goto('/?demoRole=store#/material-inward');
    await page.selectOption('[data-action="select-po"]', 'po-1');
    await expect(page.locator('[data-inward-row="pli-1"]')).toBeVisible();

    await page.setInputFiles('#mi-challan-file', {
      name: 'scanned-challan.png',
      mimeType: 'image/png',
      buffer: Buffer.from('not a real png, just a placeholder for a scanned image'),
    });

    await expect(page.locator('[data-role="challan-parse-note"]')).toContainText('enter received quantities by hand');
    await expect(page.locator('[data-action="received-qty"][data-po-line-item-id="pli-1"]')).toHaveValue('');
    await expect(page.locator('text=Selected: scanned-challan.png')).toBeVisible();
  });

  test('a past receipt with an attached challan shows a View link', async ({ page }) => {
    await page.route('**/rest/v1/purchase_orders**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          { id: 'po-1', po_number: 'PO-1001', status: 'partially_received', deleted_at: null, project: { id: 'p1', name: 'Bridge Build' }, vendor: null },
        ]),
      })
    );
    await page.route('**/rest/v1/master_material_status**', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: '[]' })
    );
    await page.route('**/rest/v1/material_inward*', (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith('/material_inward')) {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify([
            {
              id: 'inward-1',
              received_date: '2026-01-15',
              notes: null,
              challan_file_path: 'inward-1/1700000000000-challan.pdf',
              challan_file_name: 'challan.pdf',
              line_items: [{ po_line_item: { item_name: 'Base Angle' }, received_qty: 500 }],
            },
          ]),
        });
      }
      return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
    });
    await page.route('**/storage/v1/object/sign/challan-documents/**', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: '{"signedURL":"/challan-documents/inward-1/x?token=abc"}' })
    );

    await page.goto('/?demoRole=store#/material-inward');
    await page.selectOption('[data-action="select-po"]', 'po-1');

    const historyRow = page.locator('[data-history-row="inward-1"]');
    await expect(historyRow).toBeVisible();
    await expect(historyRow.locator('[data-action="view-challan"]')).toBeVisible();
  });
});

test.describe('Phase 3 — Inspection', () => {
  test('inspects a received line item with a partial accept/reject split and a rejection reason', async ({ page }) => {
    await page.route('**/rest/v1/material_inward_line_items**', (route) => {
      if (route.request().method() === 'GET') {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify([
            {
              id: 'mil-1',
              received_qty: 100,
              po_line_item: { item_name: 'Base Angle', po: { id: 'po-1', po_number: 'PO-1001', project: { name: 'Bridge Build' } } },
              inward: { received_date: '2026-01-15', deleted_at: null },
              inspection_results: [],
            },
          ]),
        });
      }
      return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
    });

    let inspectionInsertBody = null;
    await page.route('**/rest/v1/inspection_results**', (route) => {
      inspectionInsertBody = route.request().postDataJSON();
      return route.fulfill({ status: 201, contentType: 'application/json', body: '{}' });
    });

    await page.goto('/?demoRole=admin#/inspection');
    await expect(page.locator('[data-screen="inspection"]')).toBeVisible();
    await expect(page.locator('[data-inspection-row="mil-1"]')).toContainText('Base Angle');

    await page.click('[data-action="toggle-row"][data-id="mil-1"]');
    await page.fill('[data-action="accepted-qty"][data-id="mil-1"]', '80');
    await page.fill('[data-action="rejected-qty"][data-id="mil-1"]', '20');
    await page.fill('[data-action="rejection-reason"][data-id="mil-1"]', 'Surface damage on 20 units');
    await page.click('[data-action="save-inspection"][data-id="mil-1"]');

    await expect(page.locator('[data-inspection-form="mil-1"]')).toHaveCount(0);
    expect(inspectionInsertBody).toEqual({
      inward_line_item_id: 'mil-1',
      accepted_qty: 80,
      rejected_qty: 20,
      rejection_reason: 'Surface damage on 20 units',
      inspected_by: 'demo-u1',
    });
  });

  test('requires accepted + rejected to equal the received quantity, and a reason when rejecting', async ({ page }) => {
    await page.route('**/rest/v1/material_inward_line_items**', (route) => {
      if (route.request().method() === 'GET') {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify([
            {
              id: 'mil-1',
              received_qty: 100,
              po_line_item: { item_name: 'Base Angle', po: { id: 'po-1', po_number: 'PO-1001', project: { name: 'Bridge Build' } } },
              inward: { received_date: '2026-01-15', deleted_at: null },
              inspection_results: [],
            },
          ]),
        });
      }
      return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
    });
    let insertCalled = false;
    await page.route('**/rest/v1/inspection_results**', (route) => {
      insertCalled = true;
      route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    });

    await page.goto('/?demoRole=admin#/inspection');
    await page.click('[data-action="toggle-row"][data-id="mil-1"]');
    await page.fill('[data-action="accepted-qty"][data-id="mil-1"]', '80');
    await page.fill('[data-action="rejected-qty"][data-id="mil-1"]', '10');
    await page.click('[data-action="save-inspection"][data-id="mil-1"]');

    await expect(page.locator('[data-inspection-form="mil-1"]')).toBeVisible();
    expect(insertCalled).toBe(false);
  });

  test('typing a decimal quantity character by character keeps focus and lands correctly (regression)', async ({ page }) => {
    await page.route('**/rest/v1/material_inward_line_items**', (route) => {
      if (route.request().method() === 'GET') {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify([
            {
              id: 'mil-1',
              received_qty: 100,
              po_line_item: { item_name: 'Base Angle', po: { id: 'po-1', po_number: 'PO-1001', project: { name: 'Bridge Build' } } },
              inward: { received_date: '2026-01-15', deleted_at: null },
              inspection_results: [],
            },
          ]),
        });
      }
      return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
    });

    await page.goto('/?demoRole=admin#/inspection');
    await page.click('[data-action="toggle-row"][data-id="mil-1"]');

    // Every keystroke here triggers a full re-render (to keep validation
    // live) — .fill() sets the whole value in one shot and would never
    // exercise that; pressSequentially fires one native keydown/input per
    // character, like a real person typing, which is what previously lost
    // focus after the first character (and separately dropped a mid-typed
    // decimal point, since the old type="number" field couldn't survive a
    // full node replacement while an incomplete value like "62." was
    // pending).
    const acceptedQty = page.locator('[data-action="accepted-qty"][data-id="mil-1"]');
    await acceptedQty.click();
    await acceptedQty.pressSequentially('62.5', { delay: 20 });
    await expect(acceptedQty).toHaveValue('62.5');
    await expect(acceptedQty).toBeFocused();
  });
});

test.describe('Phase 3 — Master Material Status', () => {
  test('lists per-line-item status and supports CSV export', async ({ page }) => {
    await page.route('**/rest/v1/projects**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    await page.route('**/rest/v1/master_material_status**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          {
            po_line_item_id: 'pli-1',
            po_id: 'po-1',
            po_number: 'PO-1001',
            project_name: 'Bridge Build',
            vendor_name: 'Acme',
            item_name: 'Base Angle',
            ordered_qty: 1500,
            received_qty: 1500,
            accepted_qty: 1400,
            rejected_qty: 100,
            pending_qty: 0,
            po_status: 'received_inspected',
          },
        ]),
      })
    );

    await page.goto('/?demoRole=admin#/master-material-status');
    await expect(page.locator('[data-screen="master-material-status"]')).toBeVisible();
    const row = page.locator('[data-mms-row="pli-1"]');
    await expect(row).toContainText('Base Angle');
    await expect(row).toContainText('1500');
    await expect(row).toContainText('Received & Inspected');

    const downloadPromise = page.waitForEvent('download');
    await page.click('[data-action="export-csv"]');
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/^master-material-status-.*\.csv$/);
  });

  test('shows an empty state when no line items match', async ({ page }) => {
    await page.route('**/rest/v1/projects**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    await page.route('**/rest/v1/master_material_status**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));

    await page.goto('/?demoRole=admin#/master-material-status');
    await expect(page.locator('[data-screen="master-material-status"]')).toContainText('No line items match');
  });
});
