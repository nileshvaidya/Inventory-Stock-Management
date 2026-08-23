import { describe, it, expect } from 'vitest';
import { canViewModule } from './navPermissions.js';

describe('canViewModule', () => {
  it('lets everyone view dashboard and help regardless of role', () => {
    expect(canViewModule('/dashboard', null)).toBe(true);
    expect(canViewModule('/help', 'store')).toBe(true);
  });

  it('restricts bill payments to the authorized role only', () => {
    expect(canViewModule('/bill-payments', 'authorized')).toBe(true);
    expect(canViewModule('/bill-payments', 'admin')).toBe(false);
    expect(canViewModule('/bill-payments', null)).toBe(false);
  });

  it('restricts users & roles to admin only', () => {
    expect(canViewModule('/users', 'admin')).toBe(true);
    expect(canViewModule('/users', 'purchase')).toBe(false);
  });

  it('allows a module to multiple listed roles', () => {
    expect(canViewModule('/inventory', 'store')).toBe(true);
    expect(canViewModule('/inventory', 'production')).toBe(true);
    expect(canViewModule('/inventory', 'purchase')).toBe(false);
  });

  it('denies every restricted module to a role-less account', () => {
    expect(canViewModule('/inventory', null)).toBe(false);
    expect(canViewModule('/users', null)).toBe(false);
  });
});
