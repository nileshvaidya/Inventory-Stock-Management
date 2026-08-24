# Inventory & Stock Management

Purchasing, inward/inspection, inventory, nested BoM, work-order, and
invoice/bill-payment management for ASK Info-Solutions LLP.

- **Frontend**: plain HTML + Tailwind CSS + vanilla JS (ES modules), no UI
  framework. Vite is the dev server/bundler only.
- **Auth + DB**: Supabase (Postgres + Row Level Security + Supabase Auth).
- **Testing**: Vitest + jsdom (unit/logic), Playwright (e2e, against demo
  mode + a mocked Supabase HTTP layer — no live project needed), Node
  integration scripts (`scripts/test-rls-*.mjs`, real RLS/RPC checks
  against a live Supabase project), ESLint + `tsc --noEmit` (lint/typecheck).
- **CI/CD**: GitHub Actions (lint → typecheck → unit → e2e → build, plus an
  `integration` job for the RLS scripts) on every push/PR — see Testing
  below for what each layer covers and the secrets the integration job
  needs.
- **Deploy**: Vercel, backed by Supabase.

This scaffold, its folder conventions, the Nocturne design-token system,
and the auth/layout patterns are ported directly from the
[Task_Management (WorkSync)](https://github.com/nileshvaidya/Task_Management)
app, per the build brief. See `design-reference/README.md` for what's
pending from the real Claude Design mockup.

**Current status: Phase 2 (Purchase Orders: upload, parse, Order Status) — see Phase 2 below.**

## Project layout

```
index.html              # single shell — <main id="app">, dialog mount point
src/
  main.js                 # entry: imports styles, starts the router
  router.js                 # hash router + auth guard (one entry per sidebar module)
  api.js                      # Supabase client
  auth.js                       # session/profile helpers, signIn/signUp/signOutUser
  admin.js                        # Users & Roles data layer (fetchAdminUsers/inviteUser/setUserRole/setUserStatus)
  roles.js                          # confirmed role list — app-layer source of truth, mirrors schema.sql's CHECK
  navPermissions.js                   # role -> visible-module matrix (sidebar + route guards read this)
  validation.js                         # pure form-validation logic
  demoMode.js                             # VITE_DEMO_MODE + ?demoRole= dev bypass
  state.js                                  # small in-memory store + pub-sub
  layout.js                                   # shared app shell (desktop sidebar / mobile top bar+tabs)
  components.js                                 # shared render helpers (escapeHtml, renderIdentityBlock, ...)
  placeholderScreen.js                            # factory for "coming in Phase N" module screens;
                                                     applies the navPermissions route guard for every placeholder
  screens/                                          # one file per sidebar module — login.js, dashboard.js,
                                                       help.js, users.js are real; the rest are placeholders
  dialogs/
    addUserDialog.js                                  # "Add User" modal (Phase 1)
  styles/
    tailwind-base.css                                   # @tailwind base
    nocturne.css                                          # design tokens/components, ported from Task_Management
    tailwind-components-utilities.css                       # @tailwind components/utilities
e2e/
  phase0.spec.js            # Playwright — auth guard, sign-up validation, inactive-user block, sign-out
  phase1.spec.js              # Playwright — nav permission matrix, route guards, Users & Roles screen
scripts/
  test-rls-users.mjs          # RLS/RPC integration tests against a REAL Supabase project (CI's `integration` job)
supabase/
  schema.sql               # running source of truth for the DB schema + RLS
  README.md                  # Supabase project setup steps
  functions/
    admin-invite-user/       # Edge Function: creates the auth user + profile row for "Add User"
.github/workflows/ci.yml   # lint → typecheck → unit → e2e → build, + a separate RLS integration job
```

## Testing

Three layers, each covering what the others can't:

- **Unit tests** (`npm test`): pure logic — form validation, the
  nav-permission matrix, routing. No network, no DOM beyond jsdom.
- **E2E tests** (`npm run e2e`): full page interactions against demo mode
  with the entire Supabase HTTP layer mocked via Playwright's
  `page.route()` — sidebar visibility per role, route guards, dialog
  validation, the sign-in/sign-out flow. Runs anywhere, no live Supabase
  project needed, which is also why some Phase 0 signup-validation tests
  assert "Supabase never got called" rather than which specific error
  banner shows — several fields carry native HTML constraints
  (`type="email"`, `minlength`) that match the JS validation exactly, and
  a real browser blocks the form submission via its own native UI before
  our JS ever runs for those particular invalid values.
- **Integration tests** (`npm run test:integration`,
  `scripts/test-rls-users.mjs`): the one thing the above two can't cover —
  whether RLS policies and the security-definer RPCs actually enforce what
  they claim against a real Postgres database. Needs `SUPABASE_URL`,
  `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` (service role only ever
  used to create/delete throwaway test users; every assertion runs through
  an anon-key client signed in as one of them, same as the real app).

CI runs all three on every push/PR. The `integration` job needs those same
three values as **GitHub Actions repo secrets** (Settings → Secrets and
variables → Actions → New repository secret) — without them it logs a
warning and skips rather than failing the whole pipeline. Point them at a
disposable/staging Supabase project if you have one, not production — the
script creates and deletes real auth users on every run.

## Local development

```bash
npm install
cp .env.example .env   # fill in your Supabase project URL/anon key
npm run dev
```

Without a `.env`, the app still boots (`VITE_DEMO_MODE=true` + `?demoRole=admin`
in the URL bypasses Supabase Auth with a local mock user) so the shell can be
click-tested before a Supabase project exists — see `src/demoMode.js`. This is
a dev/QA convenience only: the real Phase 0 test cases (sign up, sign in,
session persistence) need a real Supabase project wired up.

## Deployment

Vercel project + Supabase project are set up and owned outside this repo
(see the open items in this Phase 0 handoff). Once both exist:

1. Vercel: import this repo, framework preset "Vite", build command
   `npm run build`, output directory `dist` (already in `vercel.json`).
2. Vercel → Project Settings → Environment Variables: add
   `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` from the Supabase
   project (Production **and** Preview environments).
3. Push to `main` → auto-deploys.

## Phases

See the build brief for the full phase-by-phase scope and test-case tables.
Phase 0 is scaffold/auth/shell only; every other sidebar module is a
placeholder screen until its phase lands, gated the same way this repo's
Phase 0 build gated the Bill Payments module's restricted-role visibility
from day one (see `src/layout.js`, `src/screens/billPayments.js`,
`src/screens/help.js`).

## Phase 1 — resolved

Nav permission matrix confirmed as proposed (`src/navPermissions.js`).
Still open, not blocking: the Claude Design mockup, and the "last admin"
edge case noted below.

## Phase 2 — open items (need your input before Phase 3)

1. **Design mockup**: still not available — PO Upload/Order Status layout
   is built without it.
2. **PDF parsing accuracy**: fixed and calibrated against a real PO
   (`PO/AISL/2026-27/0032`) — see "PDF parsing fix" below.
   `src/pdfParser.js` reconstructs real text lines from pdf.js's
   Y/X-positioned text items (the original version space-joined an entire
   page into one line, so line-item parsing never actually worked against
   a real PDF), matches both a simple `<description> <qty> <rate>` shape
   and a real-world `<description> <qty> <unit-of-measure> <rate>
   <discount/tax/amount columns>` shape, and now also pre-fills PO Number
   and Order Date when found. Every parsed row is still editable/deletable
   and rows can be added by hand before saving (P2-2, P2-6), so a bad or
   partial parse never blocks creating a PO — but this is calibrated
   against one real vendor template, not a guarantee across every possible
   PO layout.
3. **Deactivating your own last admin account** (carried over from Phase
   1): still not guarded against — flagging again since it hasn't been
   addressed.
4. **Production schema**: Phase 2's schema.sql additions (`vendors`,
   `projects`, `purchase_orders`, `po_line_items`, `is_purchase_or_admin`)
   were confirmed applied to staging (CI's `integration` job passes against
   it) — please confirm they've also been run on the **production**
   Supabase project before Phase 3 adds more tables on top.

## Phase 0 — resolved

Design mockup and Vercel/Supabase creation are still open per above; the
rest of Phase 0's open items (role list, new-account role) were resolved —
role list confirmed as proposed, and a role-less account intentionally sees
almost nothing until an admin assigns a role (see item 2 above).
