# Inventory & Stock Management

Purchasing, inward/inspection, inventory, nested BoM, work-order, and
invoice/bill-payment management for ASK Info-Solutions LLP.

- **Frontend**: plain HTML + Tailwind CSS + vanilla JS (ES modules), no UI
  framework. Vite is the dev server/bundler only.
- **Auth + DB**: Supabase (Postgres + Row Level Security + Supabase Auth).
- **Testing**: Vitest + jsdom (unit/logic), ESLint + `tsc --noEmit`
  (lint/typecheck).
- **Deploy**: Vercel, backed by Supabase.

This scaffold, its folder conventions, the Nocturne design-token system,
and the auth/layout patterns are ported directly from the
[Task_Management (WorkSync)](https://github.com/nileshvaidya/Task_Management)
app, per the build brief. See `design-reference/README.md` for what's
pending from the real Claude Design mockup.

**Current status: Phase 1 (User & Role Management) — see Phase 1 below.**

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
supabase/
  schema.sql               # running source of truth for the DB schema + RLS
  README.md                  # Supabase project setup steps
  functions/
    admin-invite-user/       # Edge Function: creates the auth user + profile row for "Add User"
```

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

## Phase 1 — open items (need your input before Phase 2)

1. **Design mockup**: still not available — the role→module visibility
   matrix below and the Users & Roles table layout are both built without
   it. See `design-reference/README.md`.
2. **Nav permission matrix** (`src/navPermissions.js`): which roles see
   which sidebar modules isn't specified anywhere in the build brief or the
   (pending) mockup, so a reasonable default was assumed and needs your
   sign-off:
   - Dashboard, Help: everyone
   - PO Upload, Order Status: Admin, Purchase
   - Material Inward: Admin, Store
   - Inspection: Admin, Inspector
   - Master Material Status: Admin, Purchase, Store, Inspector
   - Inventory: Admin, Store, Production
   - BoM Builder: Admin, Production
   - Work Orders: Admin, Production, Store
   - Invoices: Admin, Authorized
   - Reports: Admin, Authorized, Production
   - Users & Roles, Action Log: Admin only
   - Bill Payments: Authorized only (per the build brief)

   A role-less account (signed up, not yet assigned) sees only Dashboard +
   Help — least privilege by default. This is a one-file change
   (`MODULE_ROLES` in `src/navPermissions.js`) if any of it's wrong.
3. **Deactivating your own last admin account**: `set_user_status`/
   `set_user_role` block an admin from changing *their own* row (so no one
   locks themselves out solo), but nothing yet stops the *last* admin from
   demoting or deactivating some *other* admin down to zero admins total.
   Not fixed pre-emptively — flagging it as a decision, not a guess.

## Phase 0 — resolved

Design mockup and Vercel/Supabase creation are still open per above; the
rest of Phase 0's open items (role list, new-account role) were resolved —
role list confirmed as proposed, and a role-less account intentionally sees
almost nothing until an admin assigns a role (see item 2 above).
