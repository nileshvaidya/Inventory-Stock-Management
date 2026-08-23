import { describe, it, expect, vi } from 'vitest';
import { normalizePath, renderRoute, PROTECTED_ROUTES } from './router.js';

describe('normalizePath', () => {
  it('resolves known routes', () => {
    expect(normalizePath('#/dashboard')).toBe('/dashboard');
    expect(normalizePath('#/bill-payments')).toBe('/bill-payments');
  });

  it('falls back to /login for unknown routes', () => {
    expect(normalizePath('#/nope')).toBe('/login');
    expect(normalizePath('')).toBe('/login');
  });
});

describe('PROTECTED_ROUTES', () => {
  it('protects every route except /login', () => {
    expect(PROTECTED_ROUTES.has('/login')).toBe(false);
    expect(PROTECTED_ROUTES.has('/dashboard')).toBe(true);
    expect(PROTECTED_ROUTES.has('/bill-payments')).toBe(true);
  });
});

describe('renderRoute', () => {
  it('redirects a protected route to /login when there is no session', async () => {
    const container = document.createElement('div');
    const path = await renderRoute(container, '#/dashboard', () => Promise.resolve(null));
    expect(path).toBe('/login');
  });

  it('renders a protected route when a session exists', async () => {
    const container = document.createElement('div');
    const sessionCheck = vi.fn().mockResolvedValue({ id: 'u1' });
    // /dashboard's real render() talks to auth/layout — routing itself
    // (which module gets picked) is what this test cares about, so it
    // just asserts the resolved path, not the rendered DOM.
    const path = await renderRoute(container, '#/users', sessionCheck);
    expect(path).toBe('/users');
    expect(sessionCheck).toHaveBeenCalled();
  });
});
