// Dev-only convenience: `?demoRole=admin` (etc.) in the URL bypasses real
// Supabase auth entirely, behind VITE_DEMO_MODE so it can never activate in
// a production build unless explicitly enabled. Lets the deployed Phase 0
// shell be click-tested before a real Supabase project is wired up. Never
// reference this from auth.js's real sign-in/sign-up path.
//
// Only the roles actually exercised by demo-mode e2e tests are listed here
// — add another entry if a test needs one (see src/roles.js for the full
// confirmed role list: admin, purchase, store, inspector, authorized,
// production).
export const DEMO_USERS = {
  admin: {
    id: 'demo-u1',
    name: 'Demo Admin',
    email: 'admin@example.com',
    role: 'admin',
    status: 'active',
  },
  authorized: {
    id: 'demo-u2',
    name: 'Demo Accounts',
    email: 'accounts@example.com',
    role: 'authorized',
    status: 'active',
  },
  store: {
    id: 'demo-u3',
    name: 'Demo Store',
    email: 'store@example.com',
    role: 'store',
    status: 'active',
  },
  production: {
    id: 'demo-u4',
    name: 'Demo Production',
    email: 'production@example.com',
    role: 'production',
    status: 'active',
  },
};

/**
 * @param {boolean} [demoModeEnabled]
 * @param {string} [search]
 */
export function getDemoUser(
  demoModeEnabled = import.meta.env.VITE_DEMO_MODE === 'true',
  search = window.location.search
) {
  if (!demoModeEnabled) return null;
  const role = new URLSearchParams(search).get('demoRole');
  return role in DEMO_USERS ? DEMO_USERS[role] : null;
}
