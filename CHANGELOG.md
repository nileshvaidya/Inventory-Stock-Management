# Changelog

## Phase 0: Project scaffold, auth, base shell

New repo, mirroring the Task_Management (WorkSync) app's scaffold: Vite +
Tailwind + vanilla JS frontend, Supabase Auth + Postgres backend, Nocturne
design tokens ported as-is. Added:

- Supabase Auth sign-up/sign-in/sign-out (`src/auth.js`, `src/screens/login.js`),
  with a `public.users` profile row created on sign-up and RLS restricting
  each user to their own row (`supabase/schema.sql`).
- Hash router (`src/router.js`) with a protected-route guard, and one route
  per sidebar module named in the build brief (14 total) — all placeholder
  screens except Dashboard, Help, and Login.
- App shell (`src/layout.js`): desktop sidebar / mobile top bar + bottom
  tabs on real CSS breakpoints, sidebar identity block, sign-out.
- Bill Payments module gated to the `authorized` role at three points from
  day one: hidden from the sidebar nav, redirected away from its route, and
  excluded from the in-app Help content — pending Phase 10's fourth layer
  (RLS on the `bill_payments` table, once that table exists).
- Demo mode (`?demoRole=`) so the deployed shell is click-testable before a
  real Supabase project is connected.
- Vitest unit tests for form validation and routing.

Not yet done, tracked as open items in `README.md`: the real Claude Design
mockup hasn't been shared, so nav labels/layout are provisional; role list
isn't finalized.

## Fix: self-heal `users.role` NOT NULL drift in schema.sql

Live Phase 0 deploy testing hit "null value in column role violates
not-null constraint" on sign-up — the deployed `users` table had `role`
NOT NULL despite `schema.sql` defining it as nullable, because `create
table if not exists` is a no-op against a table that already existed from
an earlier run. Added `alter table public.users alter column role drop
not null;` right after the table creation so re-running the file repairs
this drift (a no-op when the column's already nullable). Also confirmed:
Vercel + Supabase are live and Phase 0 sign-up/sign-in works end to end.

## Phase 1: User & Role Management

Role list confirmed: Admin, Purchase, Store/Warehouse, Inspector,
Accounts/Authorized, Production (`admin`/`purchase`/`store`/`inspector`/
`authorized`/`production` as stored values — `src/roles.js`). Added:

- `users_role_check` CHECK constraint on `public.users.role`, plus
  security-definer RPCs (`is_admin`, `admin_list_users`, `set_user_role`,
  `set_user_status`) mirroring the Task_Management scaffold's
  is_active_manager/admin_list_users/set_user_status pattern — an
  admin can't change their own role or status, so they can't lock
  themselves out (`supabase/schema.sql`).
- `admin-invite-user` Edge Function for "Add User" (needs the
  service-role key, same reason as the Task_Management scaffold's
  equivalent function — see `supabase/README.md` for deploy steps).
- `src/navPermissions.js`: a role → visible-module matrix, now the single
  source of truth for both sidebar visibility (`src/layout.js`) and
  route-level guards (`src/placeholderScreen.js`, so every placeholder
  screen is now gated, not just Bill Payments). A role-less account sees
  only Dashboard + Help. The actual matrix is an unconfirmed assumption —
  see the open item in `README.md`.
- Real Users & Roles screen (`src/screens/users.js`): user list, Add User
  dialog, per-row role reassignment, activate/deactivate — admin-only,
  enforced both client-side (redirect) and server-side (every RPC checks
  `is_admin()` itself).
- Unit tests for the invite-user form validation and the nav-permission
  matrix.
