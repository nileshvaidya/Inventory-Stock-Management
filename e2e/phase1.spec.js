// Phase 1 — User & Role Management. Nav visibility, route guards, and
// screen rendering, all against demo mode + a mocked Supabase HTTP layer.
// Real RLS/RPC enforcement (P1-3, P1-5) is covered separately by
// scripts/test-rls-users.mjs against a real database.
import { test, expect } from '@playwright/test';

test.describe('Phase 1 — nav permission matrix (P1-2)', () => {
  test('store role sees only its permitted modules', async ({ page }) => {
    await page.goto('/?demoRole=store#/dashboard');

    await expect(page.locator('[data-nav="/dashboard"]').first()).toBeVisible();
    await expect(page.locator('[data-nav="/material-inward"]').first()).toBeVisible();
    await expect(page.locator('[data-nav="/master-material-status"]').first()).toBeVisible();
    await expect(page.locator('[data-nav="/inventory"]').first()).toBeVisible();
    await expect(page.locator('[data-nav="/work-orders"]').first()).toBeVisible();

    await expect(page.locator('[data-nav="/po-upload"]')).toHaveCount(0);
    await expect(page.locator('[data-nav="/order-status"]')).toHaveCount(0);
    await expect(page.locator('[data-nav="/inspection"]')).toHaveCount(0);
    await expect(page.locator('[data-nav="/bom-builder"]')).toHaveCount(0);
    await expect(page.locator('[data-nav="/invoices"]')).toHaveCount(0);
    await expect(page.locator('[data-nav="/reports"]')).toHaveCount(0);
    await expect(page.locator('[data-nav="/users"]')).toHaveCount(0);
    await expect(page.locator('[data-nav="/action-log"]')).toHaveCount(0);
    await expect(page.locator('[data-nav="/bill-payments"]')).toHaveCount(0);
  });

  test('authorized role sees Bill Payments; admin sees admin-only modules but not Bill Payments', async ({ page }) => {
    await page.goto('/?demoRole=authorized#/dashboard');
    await expect(page.locator('[data-nav="/bill-payments"]').first()).toBeVisible();
    await expect(page.locator('[data-nav="/invoices"]').first()).toBeVisible();
    await expect(page.locator('[data-nav="/reports"]').first()).toBeVisible();
    await expect(page.locator('[data-nav="/users"]')).toHaveCount(0);

    await page.goto('/?demoRole=admin#/dashboard');
    await expect(page.locator('[data-nav="/users"]').first()).toBeVisible();
    await expect(page.locator('[data-nav="/action-log"]').first()).toBeVisible();
    // Bill Payments is restricted to the 'authorized' role specifically —
    // admin is not automatically included, by design (build brief §1).
    await expect(page.locator('[data-nav="/bill-payments"]')).toHaveCount(0);
  });
});

test.describe('Phase 1 — route guard on a restricted module (P1-3)', () => {
  test('a non-admin navigating directly to #/users is redirected to the dashboard', async ({ page }) => {
    await page.goto('/?demoRole=store#/users');
    await expect(page).toHaveURL(/#\/dashboard$/);
    await expect(page.locator('[data-screen="dashboard"]')).toBeVisible();
  });

  test('a non-authorized role navigating directly to #/bill-payments is redirected to the dashboard', async ({ page }) => {
    await page.goto('/?demoRole=admin#/bill-payments');
    await expect(page).toHaveURL(/#\/dashboard$/);
  });
});

test.describe('Phase 1 — Users & Roles screen (admin)', () => {
  test('lists users returned by admin_list_users and shows Add User', async ({ page }) => {
    await page.route('**/rest/v1/rpc/admin_list_users**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          { id: 'demo-u1', name: 'Demo Admin', email: 'admin@example.com', role: 'admin', status: 'active' },
          { id: 'u2', name: 'Jane Store', email: 'jane@example.com', role: 'store', status: 'active' },
        ]),
      })
    );

    await page.goto('/?demoRole=admin#/users');
    await expect(page.locator('[data-screen="users"]')).toBeVisible();
    const row = page.locator('[data-user-row="u2"]');
    await expect(row).toBeVisible();
    await expect(row).toContainText('Jane Store');
    await expect(page.locator('[data-action="add-user"]')).toBeVisible();
  });

  test('a row for the viewer themself disables role/status controls', async ({ page }) => {
    await page.route('**/rest/v1/rpc/admin_list_users**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          { id: 'demo-u1', name: 'Demo Admin', email: 'admin@example.com', role: 'admin', status: 'active' },
        ]),
      })
    );

    await page.goto('/?demoRole=admin#/users');
    const selfRow = page.locator('[data-user-row="demo-u1"]');
    await expect(selfRow).toContainText('(you)');
    await expect(selfRow.locator('[data-action="role-select"]')).toBeDisabled();
    await expect(selfRow.locator('[data-action="toggle-status"]')).toBeDisabled();
  });

  test('the Add User dialog validates before calling the invite function', async ({ page }) => {
    await page.route('**/rest/v1/rpc/admin_list_users**', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: '[]' })
    );
    let inviteCalled = false;
    await page.route('**/functions/v1/admin-invite-user**', (route) => {
      inviteCalled = true;
      route.fulfill({ status: 200, body: '{}' });
    });

    await page.goto('/?demoRole=admin#/users');
    await page.click('[data-action="add-user"]');
    await page.click('[data-action="submit"]');

    // The Name field's native `required` attribute blocks the browser's own
    // 'submit' event before our JS validation ever runs (same as the
    // signup-form native-vs-custom-validation note in phase0.spec.js) — the
    // guarantee that actually matters is that the invite function never
    // gets called with an incomplete form, regardless of which layer
    // caught it.
    await page.waitForTimeout(300);
    expect(inviteCalled).toBe(false);
  });
});

test.describe('Phase 1 — Help excludes Bill Payments for non-authorized roles', () => {
  test('store role\'s help content has no mention of Bill Payments', async ({ page }) => {
    await page.goto('/?demoRole=store#/help');
    await expect(page.locator('[data-screen="help"]')).toBeVisible();
    await expect(page.locator('[data-screen="help"]')).not.toContainText('Bill Payments');
  });

  test('authorized role\'s help content documents Bill Payments', async ({ page }) => {
    await page.goto('/?demoRole=authorized#/help');
    await expect(page.locator('[data-screen="help"]')).toContainText('Bill Payments');
  });
});

test.describe('Phase 1 — Help manual: How To and FAQ', () => {
  test('table of contents jumps to a section, and screenshots load', async ({ page }) => {
    await page.goto('/?demoRole=admin#/help');
    await expect(page.locator('[data-screen="help"]')).toBeVisible();

    await page.click('[data-toc-link][href="#help-invoices"]');
    await expect(page.locator('#help-invoices')).toBeInViewport();

    const shot = page.locator('#help-po-upload img').first();
    await expect(shot).toHaveAttribute('src', /\/help\/screenshots\/.+\.png$/);
    // naturalWidth is 0 for a broken/missing image once the browser has
    // finished trying to load it — a real regression check that the file
    // in public/help/screenshots/ actually exists and decodes.
    await expect(async () => {
      const naturalWidth = await shot.evaluate((img) => /** @type {HTMLImageElement} */ (img).naturalWidth);
      expect(naturalWidth).toBeGreaterThan(0);
    }).toPass();
  });

  test('an FAQ question expands and collapses its answer', async ({ page }) => {
    await page.goto('/?demoRole=admin#/help');
    const firstQuestion = page.locator('[data-faq-question]').first();
    const firstAnswer = page.locator('[data-faq-answer]').first();

    await expect(firstAnswer).toBeHidden();
    await firstQuestion.click();
    await expect(firstAnswer).toBeVisible();
    await firstQuestion.click();
    await expect(firstAnswer).toBeHidden();
  });
});
