// Phase 0 — Scaffold, auth, base shell. UI-level flows verified against a
// mocked Supabase HTTP layer (page.route) rather than a live project — real
// RLS/DB behavior is covered separately by scripts/test-rls-users.mjs,
// which needs a real database and runs in CI's `integration` job instead.
import { test, expect } from '@playwright/test';

test.describe('Phase 0 — auth guard', () => {
  test('an unauthenticated visitor is redirected from a protected route to login', async ({ page }) => {
    await page.goto('/#/inventory');
    await expect(page.locator('[data-screen="login"]')).toBeVisible();
  });
});

test.describe('Phase 0 — sign-up validation', () => {
  // The signup fields carry native HTML constraints (type="email",
  // minlength="6") matching src/validation.js's own rules exactly — for an
  // invalid email or a too-short password specifically, the browser's own
  // constraint validation blocks the 'submit' event before our JS ever
  // runs, showing its native inline UI instead of our custom error banner.
  // That's a legitimate outcome (Supabase still never gets called either
  // way), so these assert the one guarantee that holds regardless of which
  // validation layer caught it, rather than which banner appeared.
  test('rejects a short password without calling Supabase', async ({ page }) => {
    let signupCalled = false;
    await page.route('**/auth/v1/signup**', (route) => {
      signupCalled = true;
      route.fulfill({ status: 200, body: '{}' });
    });

    await page.goto('/#/login');
    await page.click('.seg-opt:has-text("Sign Up")');
    await page.fill('#signup-name', 'Jane Doe');
    await page.fill('#signup-email', 'jane@example.com');
    await page.fill('#signup-password', 'abc');
    await page.click('[data-form="signup"] button[type="submit"]');

    await page.waitForTimeout(300);
    expect(signupCalled).toBe(false);
  });

  test('rejects an invalid email without calling Supabase', async ({ page }) => {
    let signupCalled = false;
    await page.route('**/auth/v1/signup**', (route) => {
      signupCalled = true;
      route.fulfill({ status: 200, body: '{}' });
    });

    await page.goto('/#/login');
    await page.click('.seg-opt:has-text("Sign Up")');
    await page.fill('#signup-name', 'Jane Doe');
    await page.fill('#signup-email', 'not-an-email');
    await page.fill('#signup-password', 'secret1');
    await page.click('[data-form="signup"] button[type="submit"]');

    await page.waitForTimeout(300);
    expect(signupCalled).toBe(false);
  });
});

test.describe('Phase 0 — inactive user is blocked at sign-in', () => {
  test('shows a "contact admin" message and never reaches the dashboard', async ({ page }) => {
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
          user: { id: 'inactive-1', email: 'inactive@example.com' },
        }),
      })
    );
    await page.route('**/rest/v1/users**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          id: 'inactive-1',
          name: 'Old Employee',
          email: 'inactive@example.com',
          role: 'store',
          status: 'inactive',
        }),
      })
    );
    await page.route('**/auth/v1/logout**', (route) => route.fulfill({ status: 204, body: '' }));

    await page.goto('/#/login');
    await page.fill('#signin-email', 'inactive@example.com');
    await page.fill('#signin-password', 'secret1');
    await page.click('[data-form="signin"] button[type="submit"]');

    await expect(page.locator('[data-role="error"]')).toBeVisible();
    await expect(page.locator('[data-role="error"]')).toContainText(/inactive/i);
    await expect(page.locator('[data-screen="login"]')).toBeVisible();
    await expect(page.locator('[data-screen="dashboard"]')).toHaveCount(0);
  });
});

test.describe('Phase 0 — demo mode dashboard shell', () => {
  test('renders the signed-in user\'s identity block', async ({ page }) => {
    await page.goto('/?demoRole=admin#/dashboard');
    await expect(page.locator('[data-screen="dashboard"]')).toBeVisible();
    const identity = page.locator('[data-component="identity-block"]');
    await expect(identity).toBeVisible();
    await expect(identity.locator('[data-role="identity-name"]')).toHaveText('Demo Admin');
    await expect(identity.locator('[data-role="identity-email"]')).toHaveText('admin@example.com');
  });

});

test.describe('Phase 0 — sign out', () => {
  // Deliberately NOT demo mode here: ?demoRole= lives in the URL's query
  // string, which survives a hashchange to #/login, so login.js's own
  // "already signed in? bounce to dashboard" check would see the demo
  // user again and immediately redirect right back — demo mode can't
  // meaningfully "sign out" by construction. A mocked real session (same
  // pattern as the inactive-user test above) doesn't have that problem.
  test('returns to the login screen and clears the session', async ({ page }) => {
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
          user: { id: 'active-1', email: 'active@example.com' },
        }),
      })
    );
    await page.route('**/rest/v1/users**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          id: 'active-1',
          name: 'Active User',
          email: 'active@example.com',
          role: 'admin',
          status: 'active',
        }),
      })
    );
    let logoutCalled = false;
    await page.route('**/auth/v1/logout**', (route) => {
      logoutCalled = true;
      route.fulfill({ status: 204, body: '' });
    });

    await page.goto('/#/login');
    await page.fill('#signin-email', 'active@example.com');
    await page.fill('#signin-password', 'secret1');
    await page.click('[data-form="signin"] button[type="submit"]');
    await expect(page.locator('[data-screen="dashboard"]')).toBeVisible();

    await page.click('[data-action="sign-out"]');
    await expect(page.locator('[data-screen="login"]')).toBeVisible();
    expect(logoutCalled).toBe(true);
  });
});
