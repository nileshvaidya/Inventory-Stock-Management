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

## Fix: PDF parsing against a real PO

A real PO PDF (`PO/AISL/2026-27/0032`, Odoo-generated) exposed that
`extractPdfText()` never actually worked: pdf.js's `getTextContent()`
returns one item per positioned text run with no inherent line breaks, and
the original code space-joined every item on a page into a single line —
so `parsePoText()`'s line-by-line regex had nothing to match against any
real PDF, only against hand-written test strings that already had `\n`s.
Fixed `src/pdfParser.js`:

- `extractPdfText()` now reconstructs real lines from each text item's
  `transform` matrix (Y position groups items into a line, top to bottom;
  X position orders items within a line, left to right).
- `parsePoText()` gained a second pattern for the real-world line shape —
  `<description> <qty, comma-formatted> <unit-of-measure> <rate,
  comma-formatted> <discount/tax/amount columns>` — tried after the
  original simple `<description> <qty> <rate>` shape, so existing behavior
  is unchanged for PDFs that already worked.
- Lines containing a `+<digits>` token (a phone country code, e.g. a
  supplier's `+91 90228 17411` contact line) are excluded from line-item
  matching — on real letterhead/contact blocks this otherwise reads as a
  plausible `<qty> <rate>` pair and produces a bogus row.
- `parseStatedTotal()` now prefers "Untaxed Amount" (pre-tax) over "Total"
  when both are present — Indian POs commonly state the pre-tax subtotal
  separately from the tax-inclusive grand total, and line items are
  entered pre-tax, so comparing against "Total" produced a false mismatch
  warning on every taxed PO. Also handles a leading ₹ symbol.
- New `parsePoNumber()` and `parseOrderDate()` helpers pre-fill the PO
  Number and Order Date fields from the parsed PDF
  (`src/screens/poUpload.js`) — `parseOrderDate()` tolerates the label
  ("Order Date:") and its value landing on different reconstructed lines,
  since multi-column table layouts (header row, then a values row below)
  are common.

Verified against the real PDF: line item, stated total, PO number, and
order date all now extract correctly. Added unit test coverage in
`src/pdfParser.test.js` using a reconstructed-lines fixture calibrated to
the real PO's actual content/layout.

## Fix: PO Upload — selecting a new PDF replaced-then-appended instead of replacing

Uploading a second PDF before saving mixed both POs' line items into one
table — the file-change handler spread the previous `lineItems` in with
the newly parsed rows. Each upload represents a single PO, so switching
files now starts over with the new file's parse, also resetting PO
Number/Order Date to the new file's values (or blank/today) instead of
carrying over the previous file's (`src/screens/poUpload.js`).

## Phase 2 addendum: Map Fields Manually (visual field-mapping fallback)

No regex heuristic covers every vendor's PO layout — the next follow-up
question was "what happens when one doesn't match, and can that be fixed
without touching code every time." Added a manual field-mapping fallback
to PO Upload, built to generalize to other document types later:

- `src/docMapping.js` (new, pure, doc-type-agnostic): `tokenizeLine()`
  splits a line into position-tagged tokens; `deriveColumnTemplate()` turns
  one manually-mapped example row into a reusable `{ tokenCount,
  itemNameTokenIndices, qtyTokenIndex, rateTokenIndex }` template — a
  "recorded macro", not a layout-detection model — deliberately simple:
  only lines with the exact same token count as the example are
  considered, keeping false positives low without inferring anything about
  the layout beyond what the user pointed at; `applyColumnTemplate()`
  applies a saved template to fresh lines, returning the same shape as
  `pdfParser.js`'s `parsePoText()` so both strategies are interchangeable.
- `src/importMappings.js` (new) + `supabase/schema.sql`'s
  `import_field_mappings` table (company-wide read, admin/purchase-only
  write, same RLS split as `vendors`/`projects`) — persists a saved
  template per `(doc_type, vendor_id)`, shared across the whole team, not
  just the browser that created it. `doc_type` is free text rather than a
  CHECK-constrained enum specifically so Invoices/Delivery Challans/
  Payment Receipts can reuse this same table in later phases without a
  migration.
- `src/screens/poUpload.js`: a new "Map Fields Manually" panel (raw
  extracted lines, or pasted text as a fallback when extraction itself
  finds nothing) — click a line, then click its word(s) to fill Item
  Name/Qty/Rate, "Add Row" appends into the same editable line-items table
  every other row lives in. After mapping one row, "Remember this layout
  for &lt;Vendor&gt;" saves it; future uploads from that vendor try the
  saved template automatically whenever the built-in regexes find nothing.
  Scoped to line items only for this pass — PO Number/Order Date already
  had plain editable inputs, so a dedicated mapping UI for two single
  values wasn't worth it here.
- `src/docMapping.test.js`: unit tests for tokenizing, template derivation,
  and template application (matching lines, rejecting wrong token counts,
  non-numeric qty/rate, invalid quantities/rates, no-template/no-lines).
- `e2e/phase2.spec.js`: two new tests — building a line item purely from
  pasted text via click-to-assign mapping (using a line shape the built-in
  regexes deliberately don't recognize, so the test actually exercises the
  manual path), and saving/remembering a per-vendor template.
- `scripts/test-rls-purchase-orders.mjs`: RLS coverage for
  `import_field_mappings` — purchase/admin can create, read, and update a
  mapping; store role can read but not create or update.
