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

  describe('Roles & Rights addendum: a granted right reveals its screen too', () => {
    it("a role granted manage_finance can now see Invoices, even though it's not in the fixed list", () => {
      expect(canViewModule('/invoices', 'purchase')).toBe(false);
      expect(canViewModule('/invoices', 'purchase', [{ role: 'purchase', permission: 'manage_finance' }])).toBe(true);
    });

    it('a role granted manage_items can now see Inventory and Price History', () => {
      const rows = [{ role: 'purchase', permission: 'manage_items' }];
      expect(canViewModule('/inventory', 'purchase', rows)).toBe(true);
      expect(canViewModule('/price-history', 'purchase', rows)).toBe(true);
    });

    it('a right for a different screen never leaks into an unrelated one', () => {
      const rows = [{ role: 'inspector', permission: 'manage_inspections' }];
      expect(canViewModule('/invoices', 'inspector', rows)).toBe(false);
    });

    it("Bill Payments stays authorized-only even if a role has manage_finance — it's deliberately excluded", () => {
      const rows = [{ role: 'purchase', permission: 'manage_finance' }];
      expect(canViewModule('/bill-payments', 'purchase', rows)).toBe(false);
      expect(canViewModule('/bill-payments', 'admin', rows)).toBe(false);
    });

    it('a screen with no matching right (Reports) is unaffected by any grant', () => {
      const rows = [{ role: 'purchase', permission: 'manage_finance' }, { role: 'purchase', permission: 'manage_items' }];
      expect(canViewModule('/reports', 'purchase', rows)).toBe(false);
    });
  });
});
