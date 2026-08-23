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

## Automated test harness: E2E (Playwright) + RLS integration + CI

Ported the Task_Management/WorkSync testing pattern: `e2e/phase0.spec.js`
and `e2e/phase1.spec.js` (Playwright, Supabase HTTP layer mocked via
`page.route()`, no live project needed), `scripts/test-rls-users.mjs`
(real RLS/RPC checks against a live Supabase project), and
`.github/workflows/ci.yml` (lint → typecheck → unit → e2e → build on every
push/PR, plus a separate `integration` job for the RLS script). Diagnosed
and fixed, live: a malformed `SUPABASE_URL`, a `role` NOT NULL drift, and
CORS headers missing from `admin-invite-user` — see the repo's commit
history for the full trail.

## Phase 2: Purchase Orders — upload, parse, Project/Order link, Order Status

- `src/pdfParser.js`: pdf.js text extraction + a best-effort regex heuristic
  (`<description> <qty> <rate>`) to pre-populate the line-item review
  table. No real PO template to calibrate against yet, so accuracy is
  unproven against real layouts — every row is editable/deletable and rows
  can be added by hand (P2-2, P2-6), so a bad or empty parse never blocks
  saving a PO. Caught and fixed a real regex bug during testing: without a
  mandatory separator between quantity and rate, backtracking could split
  a single number like "10" into qty=1/rate=0.
- Vendor Master (`src/vendors.js`, confirmed in-scope "suggested feature"):
  company-wide read, admin/purchase-only write, with inline "+ New Vendor"
  in the PO Upload form instead of a separate sidebar module.
- `src/screens/poUpload.js`: PDF upload, editable line-item table,
  Project/Vendor select with inline create, a non-blocking totals-mismatch
  warning (P2-7) when the parsed total doesn't match the line items' sum.
- `src/screens/orderStatus.js`: Date/Project/Status filters, CSV export
  (`src/csvExport.js` — generic, reusable by later phases' tables per the
  build brief's "export on every major table" scope item), and a soft
  delete/archive action with a "Show archived" toggle (confirmed in-scope
  soft-delete item) instead of hard delete.
- `supabase/schema.sql`: `vendors`, `projects`, `purchase_orders` (full
  status list defined now — `to_be_received` through `rejected` — even
  though Phase 2 only ever writes `to_be_received`; Phase 3 lights up the
  rest), `po_line_items`. Company-wide SELECT, admin/purchase-only
  INSERT/UPDATE via a new `is_purchase_or_admin()` security-definer
  function.
- `scripts/test-rls-purchase-orders.mjs`: RLS integration tests (admin/
  purchase can create+archive, other roles cannot; company-wide read).
- `e2e/phase2.spec.js`: route guards, manual line-item entry, inline
  project creation, form validation, Order Status rendering + CSV export
  download, empty state.
