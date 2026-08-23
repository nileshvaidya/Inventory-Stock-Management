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

**Current status: Phase 0 (scaffold, auth, base shell) — see Phase 0 below.**

## Project layout

```
index.html              # single shell — <main id="app">, dialog mount point
src/
  main.js                 # entry: imports styles, starts the router
  router.js                 # hash router + auth guard (one entry per sidebar module)
  api.js                      # Supabase client
  auth.js                       # session/profile helpers, signIn/signUp/signOutUser
  validation.js                   # pure form-validation logic
  demoMode.js                       # VITE_DEMO_MODE + ?demoRole= dev bypass
  state.js                            # small in-memory store + pub-sub
  layout.js                             # shared app shell (desktop sidebar / mobile top bar+tabs)
  components.js                           # shared render helpers (escapeHtml, renderIdentityBlock, ...)
  placeholderScreen.js                      # factory for "coming in Phase N" module screens
  screens/                                    # one file per sidebar module — login.js, dashboard.js,
                                                 help.js are real; the rest are Phase 0 placeholders
                                                 that later phases replace render() in
  styles/
    tailwind-base.css                            # @tailwind base
    nocturne.css                                    # design tokens/components, ported from Task_Management
    tailwind-components-utilities.css                 # @tailwind components/utilities
supabase/
  schema.sql               # running source of truth for the DB schema + RLS
  README.md                  # Supabase project setup steps
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

## Phase 0 — open items (need your input before Phase 1)

1. **Design mockup**: not yet available to build against — sidebar
   labels/order here come from the build brief's module list, not the
   actual Claude Design screens. Icons, spacing, and exact color-coding for
   statuses are all still open. See `design-reference/README.md`.
2. **Final role list**: `role` is an unconstrained text column for now.
   Proposed: Admin, Purchase, Store/Warehouse, Inspector,
   Accounts/Authorized, Production — confirm before Phase 1 adds the CHECK
   constraint and admin role-assignment UI. The Bill Payments gate checks
   for the literal value `'authorized'`; if the confirmed role name differs,
   that gate needs updating too.
3. **New account role**: right now a fresh sign-up gets `role = null` and
   can reach the dashboard shell but no module has any real content yet
   anyway. Confirm whether that's fine through Phase 1, or whether a
   role-less account should instead see an explicit "awaiting role
   assignment" screen.
4. **Vercel/Supabase project creation**: per your call, these are being set
   up on your end rather than through this session (no Vercel/Supabase
   tooling is available here) — Phase 0 isn't "deployed and working" until
   those exist and their env vars are wired in per the Deployment section
   above.
