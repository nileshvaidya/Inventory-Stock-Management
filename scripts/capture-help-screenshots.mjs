// One-off content-generation tool for the in-app Help manual
// (src/screens/help.js) — captures real screenshots of every screen/dialog
// in demo mode (mocked network responses, no live Supabase project
// needed) into public/help/screenshots/. Not part of the test suite; rerun
// manually (`node scripts/capture-help-screenshots.mjs`) whenever the UI
// changes enough that the manual's screenshots go stale. Needs the dev
// server already running in demo mode:
//   VITE_DEMO_MODE=true npm run dev
// Same pattern as the Task_Management/WorkSync scaffold's own
// capture-help-screenshots.mjs.
import { chromium } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const BASE_URL = process.env.HELP_SHOTS_BASE_URL || 'http://localhost:5173';
const OUT_DIR = fileURLToPath(new URL('../public/help/screenshots/', import.meta.url));
const VIEWPORT = { width: 1280, height: 800 };
const TALL_VIEWPORT = { width: 1280, height: 1100 };
const MOBILE_VIEWPORT = { width: 390, height: 844 };

// Shared fixture data — reused across screens so the screenshots tell one
// coherent story (same vendor/project/item names throughout).
const VENDORS = [
  { id: 'v1', name: 'Acme Steel Pvt Ltd', gstin: '27ABCDE1234F1Z5', contact: '+91 98200 00000', default_payment_terms_days: 30, deleted_at: null },
  { id: 'v2', name: 'Bharat Fasteners', gstin: '27PQRSX5678G2Z1', contact: '+91 98300 00000', default_payment_terms_days: 45, deleted_at: null },
];
const PROJECTS = [
  { id: 'p1', name: 'Bridge Build — Sector 12', deleted_at: null },
  { id: 'p2', name: 'Line 2 Upgrade', deleted_at: null },
];
const ITEMS = [
  { id: 'i1', name: 'M6 Hex Bolt', category: 'Fasteners', unit_of_measure: 'Nos.', reorder_level: 500, deleted_at: null },
  { id: 'i2', name: 'Terminal Block 12-way', category: 'Electrical', unit_of_measure: 'Nos.', reorder_level: 20, deleted_at: null },
  { id: 'i3', name: 'Enclosure Panel 300x200', category: 'Fabrication', unit_of_measure: 'Nos.', reorder_level: 10, deleted_at: null },
  { id: 'i4', name: 'Control Panel Assembly', category: 'Finished Goods', unit_of_measure: 'Nos.', reorder_level: 5, deleted_at: null },
  { id: 'i5', name: 'Motor Bracket Sub-assembly', category: 'Fabrication', unit_of_measure: 'Nos.', reorder_level: 15, deleted_at: null },
];

async function mockLookups(page) {
  await page.route('**/rest/v1/vendors**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(VENDORS) }));
  await page.route('**/rest/v1/projects**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(PROJECTS) }));
  await page.route('**/rest/v1/items**', (route) => {
    if (route.request().method() !== 'GET') return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify(ITEMS[0]) });
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(ITEMS) });
  });
}

async function shot(page, name, { fullPage = false } = {}) {
  await mkdir(OUT_DIR, { recursive: true });
  await page.screenshot({ path: `${OUT_DIR}${name}.png`, fullPage });
  console.log('captured', name);
}

async function run() {
  await mkdir(OUT_DIR, { recursive: true });
  const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined });

  // 1. Login — Sign In, then Sign Up
  {
    const page = await browser.newPage({ viewport: VIEWPORT });
    await page.goto(`${BASE_URL}/#/login`);
    await page.waitForSelector('[data-screen="login"]');
    await shot(page, '01-login-signin');

    await page.click('label:has-text("Sign Up")');
    await page.fill('#signup-name', 'Priya Nair');
    await page.fill('#signup-email', 'priya.nair@askinfosolutions.example');
    await shot(page, '02-login-signup');
    await page.close();
  }

  // 2. Dashboard — quick-stat cards + recent activity, admin role so every
  // card (and the admin-only activity feed) is visible at once.
  {
    const page = await browser.newPage({ viewport: VIEWPORT });
    await mockLookups(page);
    await page.route('**/rest/v1/available_stock**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          { item_id: 'i2', name: 'Terminal Block 12-way', current_qty: 12, reserved_qty: 0, available_qty: 12, reorder_level: 20 },
          { item_id: 'i3', name: 'Enclosure Panel 300x200', current_qty: 15, reserved_qty: 0, available_qty: 15, reorder_level: 10 },
        ]),
      })
    );
    await page.route('**/rest/v1/purchase_orders**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          { id: 'po1', status: 'to_be_received', deleted_at: null },
          { id: 'po2', status: 'partially_received', deleted_at: null },
        ]),
      })
    );
    await page.route('**/rest/v1/material_inward_line_items**', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ id: 'mil1', inward: { deleted_at: null }, inspection_results: [] }]) })
    );
    await page.route('**/rest/v1/work_orders**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          { id: 'wo1', status: 'open' },
          { id: 'wo2', status: 'reserved' },
        ]),
      })
    );
    await page.route('**/rest/v1/work_order_requirements**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([{ id: 'req1', shortfall_qty: 4, item: { name: 'Enclosure Panel 300x200' }, work_order: { status: 'open' } }]),
      })
    );
    await page.route('**/rest/v1/invoices**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([{ id: 'inv1', due_date: '2026-08-03', paid_at: null, deleted_at: null }]),
      })
    );
    await page.route('**/rest/v1/material_dispatch**', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ id: 'md1', authorized_at: null }]) })
    );
    await page.route('**/rest/v1/action_log**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          { id: 'log1', table_name: 'work_orders', operation: 'UPDATE', user: { name: 'Sunita Patil' }, created_at: '2026-09-01T14:22:03Z' },
          { id: 'log2', table_name: 'invoices', operation: 'INSERT', user: { name: 'Demo Admin' }, created_at: '2026-09-01T11:05:00Z' },
        ]),
      })
    );
    await page.goto(`${BASE_URL}/?demoRole=admin#/dashboard`);
    await page.waitForSelector('[data-role="dashboard-widgets"]');
    await shot(page, '03-dashboard');
    await page.close();
  }

  // 3. PO Upload — reviewed line items (parsing is simulated by typing
  // values in directly, same end state a real PDF parse would leave)
  {
    const page = await browser.newPage({ viewport: TALL_VIEWPORT });
    await mockLookups(page);
    await page.goto(`${BASE_URL}/?demoRole=admin#/po-upload`);
    await page.waitForSelector('[data-screen="po-upload"]');
    await page.click('[data-action="add-row"]');
    await page.fill('[data-action="item-name"][data-index="0"]', 'M6 Hex Bolt');
    await page.fill('[data-action="item-qty"][data-index="0"]', '200');
    await page.fill('[data-action="item-rate"][data-index="0"]', '4.5');
    await page.click('[data-action="add-row"]');
    await page.fill('[data-action="item-name"][data-index="1"]', 'Terminal Block 12-way');
    await page.fill('[data-action="item-qty"][data-index="1"]', '40');
    await page.fill('[data-action="item-rate"][data-index="1"]', '85');
    await page.selectOption('[data-action="project-select"]', 'p1');
    await page.selectOption('[data-action="vendor-select"]', 'v1');
    await page.fill('#po-number', 'PO/AISL/2026-27/0041');
    await shot(page, '04-po-upload');

    // Map Fields Manually panel. The pasted line's numbers happen to also
    // satisfy pdfParser's own simple regex (it isn't a real PDF extraction,
    // just a synthetic one-liner), auto-adding an extra row with the wrong
    // column split — remove that before the shot so only the row built by
    // hand through the mapper is shown, matching what the screenshot is
    // actually meant to demonstrate.
    await page.click('[data-action="toggle-mapping"]');
    await page.fill('#paste-text', 'Terminal Block 12-way   40   Nos.   85.00   3400.00');
    await page.click('[data-action="use-pasted-text"]');
    for (const btn of await page.locator('[data-action="remove-row"]').all()) {
      await btn.click();
    }
    await page.click('[data-action="select-map-line"]');
    await page.click('[data-action="set-active-slot"][data-slot="itemName"]');
    await page.locator('[data-action="map-token"]').filter({ hasText: /^Terminal$/ }).click();
    await page.locator('[data-action="map-token"]').filter({ hasText: /^Block$/ }).click();
    await page.locator('[data-action="map-token"]').filter({ hasText: /^12-way$/ }).click();
    await page.click('[data-action="set-active-slot"][data-slot="qty"]');
    await page.locator('[data-action="map-token"]').filter({ hasText: /^40$/ }).click();
    await page.click('[data-action="set-active-slot"][data-slot="rate"]');
    await page.locator('[data-action="map-token"]').filter({ hasText: /^85\.00$/ }).click();
    await shot(page, '05-po-upload-map-fields');
    await page.close();
  }

  // 4. Order Status
  {
    const page = await browser.newPage({ viewport: VIEWPORT });
    await mockLookups(page);
    await page.route('**/rest/v1/purchase_orders**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          { id: 'po1', po_number: 'PO/AISL/2026-27/0038', project: { name: 'Bridge Build — Sector 12' }, vendor: { name: 'Acme Steel Pvt Ltd' }, order_date: '2026-08-01', status: 'partially_received', deleted_at: null },
          { id: 'po2', po_number: 'PO/AISL/2026-27/0039', project: { name: 'Line 2 Upgrade' }, vendor: { name: 'Bharat Fasteners' }, order_date: '2026-08-10', status: 'received_inspected', deleted_at: null },
          { id: 'po3', po_number: 'PO/AISL/2026-27/0031', project: { name: 'Bridge Build — Sector 12' }, vendor: { name: 'Acme Steel Pvt Ltd' }, order_date: '2026-07-02', status: 'to_be_received', deleted_at: null },
        ]),
      })
    );
    await page.goto(`${BASE_URL}/?demoRole=admin#/order-status`);
    await page.waitForSelector('[data-screen="order-status"]');
    await shot(page, '06-order-status');
    await page.close();
  }

  // 5. Material Inward — a PO selected, one line partially received
  {
    const page = await browser.newPage({ viewport: VIEWPORT });
    await page.route('**/rest/v1/purchase_orders**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([{ id: 'po1', po_number: 'PO/AISL/2026-27/0038', project: { name: 'Bridge Build — Sector 12' }, vendor: { name: 'Acme Steel Pvt Ltd' }, order_date: '2026-08-01', status: 'partially_received', deleted_at: null }]),
      })
    );
    await page.route('**/rest/v1/master_material_status**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          { po_line_item_id: 'li1', item_name: 'M6 Hex Bolt', ordered_qty: 200, received_qty: 120, accepted_qty: 120, rejected_qty: 0, pending_qty: 80 },
          { po_line_item_id: 'li2', item_name: 'Terminal Block 12-way', ordered_qty: 40, received_qty: 0, accepted_qty: 0, rejected_qty: 0, pending_qty: 40 },
        ]),
      })
    );
    await page.route('**/rest/v1/material_inward**', (route) => {
      if (route.request().method() === 'GET') {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify([
            { id: 'mi1', received_date: '2026-08-15', notes: 'First truck', line_items: [{ po_line_item: { item_name: 'M6 Hex Bolt' }, received_qty: 120 }] },
          ]),
        });
      }
      return route.fulfill({ status: 201, contentType: 'application/json', body: '{}' });
    });
    await page.goto(`${BASE_URL}/?demoRole=store#/material-inward`);
    await page.waitForSelector('[data-screen="material-inward"]');
    await page.selectOption('#mi-po', 'po1');
    await page.waitForTimeout(200);
    await page.fill('[data-action="received-qty"][data-po-line-item-id="li2"]', '40');
    await page.fill('#mi-notes', 'Second truck — terminal blocks');
    await shot(page, '07-material-inward');
    await page.close();
  }

  // 6. Inspection — a row open for accept/reject entry
  {
    const page = await browser.newPage({ viewport: VIEWPORT });
    await page.route('**/rest/v1/material_inward_line_items**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          {
            id: 'mili1',
            received_qty: 120,
            po_line_item: { item_name: 'M6 Hex Bolt', po: { id: 'po1', po_number: 'PO/AISL/2026-27/0038', project: { name: 'Bridge Build — Sector 12' } } },
            inward: { received_date: '2026-08-15', deleted_at: null },
            inspection_results: [],
          },
        ]),
      })
    );
    await page.goto(`${BASE_URL}/?demoRole=admin#/inspection`);
    await page.waitForSelector('[data-screen="inspection"]');
    await page.click('[data-action="toggle-row"]');
    await page.fill('[data-action="accepted-qty"]', '110');
    await page.fill('[data-action="rejected-qty"]', '10');
    await page.fill('[data-action="rejection-reason"]', 'Corrosion on 10 units');
    await shot(page, '08-inspection');
    await page.close();
  }

  // 7. Master Material Status
  {
    const page = await browser.newPage({ viewport: VIEWPORT });
    await mockLookups(page);
    await page.route('**/rest/v1/master_material_status**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          { po_line_item_id: 'li1', po_number: 'PO/AISL/2026-27/0038', project_name: 'Bridge Build — Sector 12', vendor_name: 'Acme Steel Pvt Ltd', item_name: 'M6 Hex Bolt', ordered_qty: 200, received_qty: 200, accepted_qty: 190, rejected_qty: 10, pending_qty: 0, po_status: 'received_inspected' },
          { po_line_item_id: 'li2', po_number: 'PO/AISL/2026-27/0039', project_name: 'Line 2 Upgrade', vendor_name: 'Bharat Fasteners', item_name: 'Terminal Block 12-way', ordered_qty: 40, received_qty: 0, accepted_qty: 0, rejected_qty: 0, pending_qty: 40, po_status: 'to_be_received' },
        ]),
      })
    );
    await page.goto(`${BASE_URL}/?demoRole=admin#/master-material-status`);
    await page.waitForSelector('[data-screen="master-material-status"]');
    await shot(page, '09-master-material-status');
    await page.close();
  }

  // 8. Inventory — ledger expanded with a movement being logged, then the
  // New Item form
  {
    const page = await browser.newPage({ viewport: TALL_VIEWPORT });
    await page.route('**/rest/v1/available_stock**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          { item_id: 'i1', name: 'M6 Hex Bolt', category: 'Fasteners', unit_of_measure: 'Nos.', current_qty: 1240, reserved_qty: 320, available_qty: 920, reorder_level: 500 },
          { item_id: 'i3', name: 'Enclosure Panel 300x200', category: 'Fabrication', unit_of_measure: 'Nos.', current_qty: 6, reserved_qty: 0, available_qty: 6, reorder_level: 10 },
        ]),
      })
    );
    await page.route('**/rest/v1/item_current_rate**', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ item_id: 'i1', rate: 8.5, effective_date: '2026-08-01' }]) })
    );
    await page.route('**/rest/v1/stock_movements**', (route) => {
      if (route.request().method() === 'GET') {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify([
            { id: 'sm1', created_at: '2026-08-15T10:00:00Z', movement_type: 'in', quantity: 120, reference_type: 'Inspection', notes: null },
            { id: 'sm2', created_at: '2026-08-20T09:00:00Z', movement_type: 'out', quantity: 40, reference_type: 'Manual', notes: 'Used on Line 2' },
          ]),
        });
      }
      return route.fulfill({ status: 201, contentType: 'application/json', body: '{}' });
    });
    await page.goto(`${BASE_URL}/?demoRole=store#/inventory`);
    await page.waitForSelector('[data-screen="inventory"]');
    await page.click('[data-action="toggle-item"]');
    await page.waitForTimeout(200);
    await page.selectOption('[data-action="movement-type"]', 'out');
    await page.fill('[data-action="movement-quantity"]', '25');
    await page.fill('[data-action="movement-notes"]', 'Issued to Bridge Build site');
    await shot(page, '10-inventory');

    await page.click('[data-action="new-item"]');
    await page.fill('#ni-name', 'Cable Gland 20mm');
    await page.fill('#ni-category', 'Electrical');
    await page.fill('#ni-reorder', '50');
    await page.fill('#ni-unit-rate', '18.75');
    await shot(page, '11-inventory-new-item');
    await page.close();
  }

  // 9. BoM Builder — list, new recipe form, and a recipe's detail
  {
    const page = await browser.newPage({ viewport: TALL_VIEWPORT });
    await mockLookups(page);
    const boms = [
      {
        id: 'bom1',
        name: 'Standard Control Panel',
        notes: 'Rev C — approved 2026-06',
        output_qty: 1,
        output_item: { id: 'i4', name: 'Control Panel Assembly', unit_of_measure: 'Nos.' },
        components: [
          { id: 'c1', component_item_id: 'i2', quantity: 4, component_item: { name: 'Terminal Block 12-way', unit_of_measure: 'Nos.' } },
          { id: 'c2', component_item_id: 'i3', quantity: 1, component_item: { name: 'Enclosure Panel 300x200', unit_of_measure: 'Nos.' } },
        ],
      },
    ];
    await page.route('**/rest/v1/boms**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(boms) }));
    await page.route('**/rest/v1/bom_production_runs**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([{ id: 'run1', created_at: '2026-08-22T00:00:00Z', quantity_produced: 5, notes: 'First batch' }]),
      })
    );
    await page.goto(`${BASE_URL}/?demoRole=production#/bom-builder`);
    await page.waitForSelector('[data-screen="bom-builder"]');
    await shot(page, '12-bom-builder');

    await page.click('[data-action="new-bom"]');
    await page.selectOption('#bom-output-item', 'i5');
    await page.fill('#bom-output-qty', '1');
    await page.fill('#bom-name', 'Motor Bracket Sub-assembly Recipe');
    await page.selectOption('[data-action="component-item"]', 'i1');
    await page.fill('[data-action="component-quantity"]', '6');
    await shot(page, '13-bom-builder-new-recipe');
    await page.click('[data-action="cancel-form"]');

    await page.click('[data-action="toggle-bom"]');
    await page.waitForTimeout(200);
    await page.fill('[data-action="production-quantity"]', '5');
    await page.fill('[data-action="production-notes"]', 'Second batch for Sector 12');
    await shot(page, '14-bom-builder-detail');
    await page.close();
  }

  // 10. Work Orders — list, then the explosion preview
  {
    const page = await browser.newPage({ viewport: TALL_VIEWPORT });
    await mockLookups(page);
    await page.route('**/rest/v1/work_orders**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          { id: 'wo1', quantity: 40, status: 'reserved', output_item: { name: 'Control Panel Assembly' }, created_at: '2026-08-25T00:00:00Z' },
          { id: 'wo2', quantity: 10, status: 'open', output_item: { name: 'Motor Bracket Sub-assembly' }, created_at: '2026-08-28T00:00:00Z' },
        ]),
      })
    );
    await page.route('**/rest/v1/rpc/explode_bom_requirements**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          { item_id: 'i2', item_name: 'Terminal Block 12-way', reservable_qty: 40, shortfall_qty: 0 },
          { item_id: 'i3', item_name: 'Enclosure Panel 300x200', reservable_qty: 6, shortfall_qty: 4 },
        ]),
      })
    );
    await page.goto(`${BASE_URL}/?demoRole=production#/work-orders`);
    await page.waitForSelector('[data-screen="work-orders"]');
    await shot(page, '15-work-orders');

    await page.click('[data-action="new-wo"]');
    await page.selectOption('#wo-output-item', 'i4');
    await page.fill('#wo-quantity', '40');
    await page.click('[data-action="check-availability"]');
    await page.waitForSelector('[data-role="preview-table"]');
    await shot(page, '16-work-orders-preview');
    await page.close();
  }

  // 11. Invoices — list, then the New Invoice form
  {
    const page = await browser.newPage({ viewport: TALL_VIEWPORT });
    await mockLookups(page);
    await page.route('**/rest/v1/purchase_orders**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([{ id: 'po1', po_number: 'PO/AISL/2026-27/0038', vendor_id: 'v1', project: { name: 'Bridge Build — Sector 12' }, vendor: { name: 'Acme Steel Pvt Ltd' } }]),
      })
    );
    await page.route('**/rest/v1/invoices**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          { id: 'inv1', invoice_number: 'ACME-2381', vendor: { name: 'Acme Steel Pvt Ltd' }, invoice_date: '2026-07-04', due_date: '2026-08-03', amount: 184500, paid_at: null, deleted_at: null, invoice_purchase_orders: [{ po: { po_number: 'PO/AISL/2026-27/0038' } }] },
          { id: 'inv2', invoice_number: 'BF-0912', vendor: { name: 'Bharat Fasteners' }, invoice_date: '2026-08-01', due_date: '2026-09-15', amount: 62300, paid_at: '2026-08-20T00:00:00Z', deleted_at: null, invoice_purchase_orders: [] },
        ]),
      })
    );
    await page.goto(`${BASE_URL}/?demoRole=authorized#/invoices`);
    await page.waitForSelector('[data-screen="invoices"]');
    await shot(page, '17-invoices');

    await page.click('[data-action="toggle-form"]');
    await page.selectOption('[data-action="form-vendor"]', 'v1');
    await page.fill('[data-action="form-invoice-number"]', 'ACME-2405');
    await page.fill('[data-action="form-amount"]', '98750');
    await page.check('[data-action="form-po"]');
    await shot(page, '18-invoices-new');
    await page.close();
  }

  // 12. Reports — three tabs
  {
    const page = await browser.newPage({ viewport: VIEWPORT });
    await page.route('**/rest/v1/available_stock**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          { item_id: 'i2', name: 'Terminal Block 12-way', category: 'Electrical', unit_of_measure: 'Nos.', current_qty: 40, reserved_qty: 40, available_qty: 0, reorder_level: 20 },
          { item_id: 'i3', name: 'Enclosure Panel 300x200', category: 'Fabrication', unit_of_measure: 'Nos.', current_qty: 6, reserved_qty: 0, available_qty: 6, reorder_level: 10 },
        ]),
      })
    );
    await page.route('**/rest/v1/stock_reservations**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([{ item_id: 'i2', quantity: 40, work_order: { output_item: { name: 'Control Panel Assembly' }, quantity: 40 } }]),
      })
    );
    await page.route('**/rest/v1/work_order_requirements**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([{ id: 'req1', shortfall_qty: 4, item: { name: 'Enclosure Panel 300x200' }, work_order: { quantity: 10, status: 'open', output_item: { name: 'Motor Bracket Sub-assembly' } } }]),
      })
    );
    await page.goto(`${BASE_URL}/?demoRole=admin#/reports`);
    await page.waitForSelector('[data-screen="reports"]');
    await page.click('[data-action="toggle-item"]');
    await shot(page, '19-reports-reservations');

    await page.click('[data-action="switch-tab"][data-tab="shortages"]');
    await shot(page, '20-reports-shortages');

    await page.click('[data-action="switch-tab"][data-tab="below-reorder"]');
    await shot(page, '21-reports-below-reorder');
    await page.close();
  }

  // 13. Users & Roles — list, then Add User dialog
  {
    const page = await browser.newPage({ viewport: VIEWPORT });
    await page.route('**/rest/v1/rpc/admin_list_users**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          { id: 'demo-u1', name: 'Demo Admin', email: 'admin@example.com', role: 'admin', status: 'active' },
          { id: 'u2', name: 'Sunita Patil', email: 'sunita@askinfosolutions.example', role: 'production', status: 'active' },
          { id: 'u3', name: 'Deepak Rao', email: 'deepak@askinfosolutions.example', role: 'store', status: 'inactive' },
        ]),
      })
    );
    await page.goto(`${BASE_URL}/?demoRole=admin#/users`);
    await page.waitForSelector('[data-screen="users"]');
    await shot(page, '22-users-roles');

    await page.click('[data-action="add-user"]');
    await page.waitForSelector('.dialog');
    await page.fill('#add-user-name', 'Anita Desai');
    await page.fill('#add-user-email', 'anita@askinfosolutions.example');
    await page.selectOption('#add-user-role', 'authorized');
    await shot(page, '23-users-roles-add-user');
    await page.close();
  }

  // 14. Action Log — list with one row's before/after detail expanded
  {
    const page = await browser.newPage({ viewport: VIEWPORT });
    await page.route('**/rest/v1/rpc/admin_list_users**', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ id: 'demo-u1', name: 'Demo Admin' }, { id: 'u2', name: 'Sunita Patil' }]) })
    );
    await page.route('**/rest/v1/action_log**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          { id: 'log1', table_name: 'work_orders', operation: 'UPDATE', row_id: 'wo1', user: { name: 'Sunita Patil' }, old_data: { status: 'open', reserved_at: null }, new_data: { status: 'reserved', reserved_at: '2026-09-01T14:22:03Z' }, created_at: '2026-09-01T14:22:03Z' },
          { id: 'log2', table_name: 'invoices', operation: 'INSERT', row_id: 'inv1', user: { name: 'Demo Admin' }, old_data: null, new_data: { invoice_number: 'ACME-2381' }, created_at: '2026-09-01T11:05:00Z' },
        ]),
      })
    );
    await page.goto(`${BASE_URL}/?demoRole=admin#/action-log`);
    await page.waitForSelector('[data-screen="action-log"]');
    await page.click('[data-action="toggle-row"]');
    await shot(page, '24-action-log');
    await page.close();
  }

  // 15. Bill Payments (authorized role only)
  {
    const page = await browser.newPage({ viewport: VIEWPORT });
    await page.route('**/rest/v1/invoices**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          { id: 'inv1', invoice_number: 'ACME-2381', vendor: { name: 'Acme Steel Pvt Ltd' }, due_date: '2026-08-03', amount: 184500, paid_at: null, deleted_at: null, bill_file_path: null, bill_file_name: null },
          { id: 'inv2', invoice_number: 'BF-0912', vendor: { name: 'Bharat Fasteners' }, due_date: '2026-09-15', amount: 62300, paid_at: null, deleted_at: null, bill_file_path: 'inv2/bill.pdf', bill_file_name: 'bharat-fasteners-aug.pdf' },
        ]),
      })
    );
    await page.goto(`${BASE_URL}/?demoRole=authorized#/bill-payments`);
    await page.waitForSelector('[data-screen="bill-payments"]');
    await shot(page, '25-bill-payments');
    await page.close();
  }

  // 16. Material Dispatch (admin role, so the Payment column is visible)
  {
    const page = await browser.newPage({ viewport: VIEWPORT });
    await mockLookups(page);
    await page.route('**/rest/v1/material_dispatch**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          {
            id: 'md1',
            dispatch_date: '2026-09-02',
            reference: 'Bridge Build — Sector 12',
            notes: null,
            challan_file_path: null,
            challan_file_name: null,
            authorized_by: null,
            authorized_at: null,
            payment_received_by: null,
            payment_received_at: null,
            line_items: [{ id: 'mdl1', item_id: 'i4', quantity: 5, item: { id: 'i4', name: 'Control Panel Assembly', unit_of_measure: 'Nos.' } }],
          },
          {
            id: 'md2',
            dispatch_date: '2026-08-28',
            reference: 'Line 2 Upgrade',
            notes: null,
            challan_file_path: 'md2/challan.pdf',
            challan_file_name: 'line2-challan.pdf',
            authorized_by: 'demo-u1',
            authorized_at: '2026-08-29T09:00:00Z',
            payment_received_by: null,
            payment_received_at: null,
            line_items: [{ id: 'mdl2', item_id: 'i5', quantity: 8, item: { id: 'i5', name: 'Motor Bracket Sub-assembly', unit_of_measure: 'Nos.' } }],
          },
        ]),
      })
    );
    await page.goto(`${BASE_URL}/?demoRole=admin#/material-dispatch`);
    await page.waitForSelector('[data-screen="material-dispatch"]');
    await shot(page, '26-material-dispatch');
    await page.close();
  }

  // 17. Price History — two rate changes for the same item, oldest first
  {
    const page = await browser.newPage({ viewport: VIEWPORT });
    await mockLookups(page);
    await page.route('**/rest/v1/item_price_history**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          {
            id: 'ph1',
            item_id: 'i1',
            rate: 12.5,
            effective_date: '2026-09-01',
            created_at: '2026-09-01T10:00:00Z',
            item: { id: 'i1', name: 'M6 Hex Bolt' },
            created_by_user: { id: 'demo-u1', name: 'Demo Admin' },
          },
          {
            id: 'ph2',
            item_id: 'i1',
            rate: 10.75,
            effective_date: '2026-05-01',
            created_at: '2026-05-01T09:00:00Z',
            item: { id: 'i1', name: 'M6 Hex Bolt' },
            created_by_user: { id: 'demo-u1', name: 'Demo Admin' },
          },
        ]),
      })
    );
    await page.goto(`${BASE_URL}/?demoRole=admin#/price-history`);
    await page.waitForSelector('[data-screen="price-history"]');
    await shot(page, '28-price-history');
    await page.close();
  }

  // 18. Stock Statement — printable letterhead-style valuation
  {
    const page = await browser.newPage({ viewport: VIEWPORT });
    await page.route('**/rest/v1/rpc/stock_statement_for_range**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          {
            item_id: 'i1', item_code: 'FS-M6HB', name: 'M6 Hex Bolt', item_type: 'RM', source: 'Bharat Fasteners', location: 'Rack A2',
            unit_of_measure: 'Nos.', opening_qty: 1100, inward_qty: 460, outward_qty: 320, closing_qty: 1240,
            rate: 12.5, rate_effective_date: '2026-09-01', stock_value: 15500,
          },
          {
            item_id: 'i2', item_code: 'EL-TB12', name: 'Terminal Block 12-way', item_type: 'RM', source: 'Voltek Electricals', location: 'Rack B1',
            unit_of_measure: 'Nos.', opening_qty: 60, inward_qty: 0, outward_qty: 20, closing_qty: 40,
            rate: 145, rate_effective_date: '2026-07-15', stock_value: 5800,
          },
          {
            item_id: 'i3', item_code: 'FB-EP302', name: 'Enclosure Panel 300x200', item_type: 'WIP', source: 'Self', location: 'Fabrication Bay',
            unit_of_measure: 'Nos.', opening_qty: 4, inward_qty: 2, outward_qty: 0, closing_qty: 6,
            rate: null, rate_effective_date: null, stock_value: null,
          },
        ]),
      })
    );
    await page.goto(`${BASE_URL}/?demoRole=admin#/stock-statement`);
    await page.waitForSelector('[data-role="stock-statement-sheet"]');
    await shot(page, '29-stock-statement');
    await page.close();
  }

  // 19. Mobile viewport — bottom tab bar
  {
    const page = await browser.newPage({ viewport: MOBILE_VIEWPORT });
    await page.goto(`${BASE_URL}/?demoRole=admin#/dashboard`);
    await page.waitForSelector('[data-screen="dashboard"]');
    await page.waitForTimeout(300);
    await shot(page, '30-mobile-dashboard');
    await page.close();
  }

  await browser.close();
  console.log('Done. Screenshots written to', OUT_DIR);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
