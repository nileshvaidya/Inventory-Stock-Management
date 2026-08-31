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

**Current status: Phase 7 (Work Orders: nested BoM explosion + stock reservation) — see Phase 7 below.**

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
  pdfParser.js                          # PO PDF text extraction + regex-based line-item/total parsing (Phase 2)
  docMapping.js                           # manual field-mapping fallback, doc-type-agnostic (Phase 2 addendum)
  importMappings.js                         # per-vendor saved mapping templates data layer (Phase 2 addendum)
  materialInward.js                           # Material Inward data layer (Phase 3)
  inspection.js                                 # Inspection data layer (Phase 3)
  masterMaterialStatus.js                         # reads the master_material_status view (Phase 3)
  poStatus.js                                       # shared PO status labels/tags — purchase_orders.status is now
                                                       # auto-computed server-side (see schema.sql's Phase 3 triggers)
  items.js                                            # Item Master data layer (Phase 4)
  inventory.js                                          # current_stock view + stock_movements ledger (Phase 4)
  invoices.js                                             # Invoices data layer (Phase 5) — the first table whose own
                                                             # RLS read is admin/authorized-only, not company-wide
  boms.js                                                   # BoM Builder data layer (Phase 6) — recipes + the
                                                               # record_bom_production() RPC (the only write path for
                                                               # production runs)
  workOrders.js                                               # Work Orders data layer (Phase 7) — explosion preview
                                                                 # + create_work_order()/reserve_work_order() RPCs
  validation.js                                               # pure form-validation logic
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
  phase2.spec.js                # Playwright — PO Upload (incl. Map Fields Manually), Order Status
  phase3.spec.js                  # Playwright — Material Inward, Inspection, Master Material Status
  phase4.spec.js                    # Playwright — Inventory (Item Master, ledger, below-reorder)
  phase5.spec.js                      # Playwright — Invoices (multi-PO link, due-date auto-fill, overdue, Mark Paid)
  phase6.spec.js                        # Playwright — BoM Builder (recipe create/edit/archive, record production)
  phase7.spec.js                          # Playwright — Work Orders (explosion preview, create, reserve, cancel)
scripts/
  test-rls-users.mjs          # RLS/RPC integration tests against a REAL Supabase project (CI's `integration` job)
  test-rls-purchase-orders.mjs  # ...for vendors/projects/purchase_orders/po_line_items/import_field_mappings
  test-rls-material-inward.mjs    # ...for material_inward/inspection_results + recompute_po_status + the view
  test-rls-inventory.mjs            # ...for items/stock_movements + the auto-stock-in trigger + current_stock
  test-rls-invoices.mjs               # ...for invoices/invoice_purchase_orders — the narrow-read RLS case
  test-rls-boms.mjs                     # ...for boms/bom_components/bom_production_runs — the cycle guard trigger
                                           # and record_bom_production()'s atomic stock-shortfall check
  test-rls-work-orders.mjs              # ...for work_orders/work_order_requirements/stock_reservations —
                                           # the netting explosion's math and reserve_work_order()'s atomic
                                           # re-availability check
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

## Phase 2 — open items

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
   `projects`, `purchase_orders`, `po_line_items`, `is_purchase_or_admin`,
   and the field-mapping addendum's `import_field_mappings`) are confirmed
   live on both staging and **production** (verified: all 6 tables, 5
   functions, and 15 policies present as of the field-mapping addendum).
   Phase 3 adds more tables on top — see its own open item below.

## Phase 2 addendum — Map Fields Manually (visual field-mapping fallback)

When `src/pdfParser.js`'s regex heuristics don't recognize a vendor's PO
layout (a different column order, an unfamiliar label, etc.), PO Upload now
offers a manual fallback instead of leaving the user to retype every line
item from scratch:

- **Raw text panel** ("Map Fields Manually", auto-expanded whenever parsing
  finds nothing): shows the PDF's extracted lines (or pasted text — a
  textarea also lets you paste text copied from a PDF viewer, for the rare
  case extraction itself finds no text layer, e.g. a scanned image PDF).
- **Click-to-assign mapping**: click a line, then click the word(s) in it
  that are the Item Name, Qty, and Rate — no retyping numbers by hand.
  "Add Row" appends the result to the same editable line-items table every
  other row lives in.
- **Per-vendor memory**: after mapping one row, "Remember this layout for
  &lt;Vendor&gt;" saves it (`import_field_mappings`, company-wide read,
  admin/purchase-only write). The **next** upload from that vendor tries
  the saved template automatically (as a fallback, only when the built-in
  regexes find nothing) — so a format only needs to be mapped once per
  vendor, not once per document.
- Deliberately scoped to **line items only** for this pass — PO Number and
  Order Date were already plain editable text/date inputs, so a dedicated
  mapping UI for two single values wasn't worth the added complexity here.

Built to generalize beyond POs: `src/docMapping.js` (tokenizing a line,
deriving/applying a column template) is document-type-agnostic — it takes
raw lines and token positions, nothing PO-specific — so Invoices, Delivery
Challans, and Payment Receipts can reuse it directly once those phases
exist, wiring up their own field labels and UI, not new parsing logic.
`import_field_mappings.doc_type` is already free text for exactly this
reason (see `supabase/schema.sql`).

## Phase 3 — Material Inward, Inspection, Master Material Status

A PO can be received across multiple partial deliveries (`material_inward`,
one row per delivery, with `material_inward_line_items` recording how much
of each PO line item arrived in that delivery). Each received line is
inspected once (`inspection_results`, unique per inward line item) into
Accepted/Rejected quantities, with a rejection reason required whenever any
quantity is rejected — enforced both in the form and as a DB check
constraint, not just client-side.

`purchase_orders.status` is no longer written directly by the app for these
transitions. `recompute_po_status()` and a set of triggers on
`material_inward`/`material_inward_line_items`/`inspection_results`
recalculate it automatically from the underlying quantities on every
relevant insert/update/delete, so it can never drift from what was actually
received/inspected regardless of which screen touched the data:

- `to_be_received` → nothing received yet.
- `partially_received` → some, but not all, ordered quantity received.
- `material_received` → fully received, not yet fully inspected.
- `received_inspected` → fully received and inspected, with **at least
  some** quantity accepted.
- `rejected` → fully received and inspected, with **nothing** accepted —
  confirmed with you: a partial rejection still shows `received_inspected`;
  Master Material Status is where the exact accepted/rejected/pending split
  per item lives, not the one-word PO status.

**Master Material Status** (`master_material_status`, a Postgres view, not
a table) shows one row per PO line item — confirmed with you over the
rollup-per-PO alternative — with Ordered/Received/Accepted/Rejected/Pending
quantities and the PO's status, filterable by Project/Status with CSV
export. It's also reused by the Material Inward screen to show "already
received" per line item when logging a new delivery, so the two screens can
never disagree about the running total.

New role-gated screens (`src/navPermissions.js`, unchanged from Phase 1's
proposed matrix): Material Inward (Store/Admin), Inspection
(Inspector/Admin), Master Material Status (Admin/Purchase/Store/Inspector,
read-only).

### Phase 3 — open items

1. **Production/staging schema**: confirmed applied to both staging (CI's
   `integration` job passes) and production.
2. **Design mockup**: still not available — these three screens are built
   without it, same as Phase 2.
3. **Deactivating your own last admin account** (carried over from Phase
   1): still not guarded against.

## Phase 4 — Inventory (Item Master + stock movement ledger)

Confirmed two design decisions before building (no mockup, and both shape
how stock ends up accurate rather than something re-entered by hand):

- **PO Upload gets an Item selector.** Each line item row has a "Linked
  Item" dropdown (plus an inline "+ New Item", same UX as Project/Vendor)
  so a new/edited PO line item can optionally link to an Item Master entry
  (`po_line_items.item_id`, nullable — existing rows keep their free-text
  `item_name` only and simply don't feed the ledger below).
- **Accepted inspections auto-create an inbound stock movement.** A
  security-definer trigger on `inspection_results` (`trg_stock_in_from_inspection`)
  fires whenever `accepted_qty > 0`: if the received line's PO line item has
  an Item linked, it inserts a matching `stock_movements` row
  (`movement_type = 'in'`, `quantity = accepted_qty`,
  `reference_type = 'inspection'`) automatically — no manual re-entry, and
  "current stock" reflects real receiving activity from day one. A known
  limitation: this fires on **insert only** — a later correction via
  `UPDATE` on `inspection_results` does not retroactively adjust stock.

`current_stock` (a Postgres view, same "security invoker inherits RLS"
pattern as `master_material_status`) rolls up `stock_movements` per item
into `qty_in`/`qty_out`/`current_qty`, joined with the Item Master's
`reorder_level` so Inventory can flag items below reorder.

- `src/screens/inventory.js` (Admin/Store/Production): current stock,
  filterable by name/category/below-reorder-only, each row expandable into
  its full movement ledger. "+ New Item" and manual "Log Movement" (an
  opening balance or a hand correction) are Store/Admin only — enforced
  both by hiding the controls for Production and, more importantly, by RLS
  server-side (`is_store_or_admin`), so Production is read-only in
  practice, not just in the UI.
- `src/screens/poUpload.js`: the new Item selector per line item, described
  above.

### Phase 4 — open items

1. **Production/staging schema**: confirmed applied to both staging (CI's
   `integration` job passes) and production.
2. **Design mockup**: still not available.
3. **Deactivating your own last admin account** (carried over from Phase
   1): still not guarded against.

## Phase 5 — Invoices (multi-PO linking, payment terms/due dates, overdue)

The first module in this schema whose own RLS restricts **read**, not just
write, to a narrow pair: Invoices is Admin/Authorized only end to end — no
other role has a stated need to see invoice or payment-term data, unlike
Phase 2-4's tables which stayed company-wide readable even when writes were
role-restricted. `is_authorized_or_admin()` mirrors the existing
`is_purchase_or_admin()`/`is_store_or_admin()` helpers.

- `invoices` (`invoice_number`, `vendor_id`, `invoice_date`,
  `payment_terms_days`, `due_date`, `amount`, `paid_at`, `notes`,
  soft-deletable) and `invoice_purchase_orders`, a many-to-many junction —
  one invoice can cover several POs (a consolidated vendor bill), and in
  principle a PO could be split across more than one invoice.
- **Overdue is computed, not stored**: `paid_at is null and due_date <
  today`. Using a nullable timestamp (`paid_at`) rather than a boolean
  means an invoice paid after its due date correctly stops showing as
  overdue the moment it's marked paid, instead of staying flagged forever.
- `src/screens/invoices.js` (Admin/Authorized): list with Vendor/Status
  filters (Pending/Overdue/Paid) and CSV export; "+ New Invoice" auto-fills
  Payment Terms from the selected vendor's `default_payment_terms_days`
  (Phase 2's Vendor Master field) and auto-computes Due Date from Invoice
  Date + Payment Terms — both still directly overridable — plus a
  checklist to link one or more of that vendor's POs; "Mark Paid" and
  archive (soft delete) actions per row.
- Confirmed as an explicit, self-contained assumption (not a retrofit of
  an existing screen, so no separate confirmation round): marking an
  invoice paid lives here in Phase 5, not deferred entirely to Phase 10's
  Bill Payments. Bill Payments' own brief ("upload/scan bills, link to a
  PO/Invoice, **mark received on payment**") suggests it may supersede or
  extend this when that phase lands — Phase 5 gives Invoices a complete,
  usable paid/overdue lifecycle in the meantime rather than leaving
  "overdue" permanently unresolvable for anything already paid.

### Phase 5 — open items

1. **Production/staging schema**: confirmed applied to both staging (CI's
   `integration` job passes) and production.
2. **Design mockup**: still not available.
3. **Deactivating your own last admin account** (carried over from Phase
   1): still not guarded against.

## Phase 6 — BoM Builder (nested bills of materials + recording production)

Confirmed two design decisions before building (no mockup, and both shape
how far "recording production" reaches):

- **Recording production consumes only a recipe's own direct components,
  one level.** Phase 7 (Work Orders) is described as the layer that
  explodes a multi-level BoM tree to check/reserve availability further
  down — Phase 6 doesn't duplicate that here. A BoM's own *structure* is
  still nested (a component can itself be an item with its own recipe), so
  there's something for Phase 7 to explode; a database trigger blocks both
  direct self-reference and any deeper circular reference at write time
  (`bom_cycle_would_exist()`, a recursive CTE), not just at explosion time.
- **A stock shortfall on any component blocks the whole production record**
  — nothing is written — rather than letting stock go negative. Same
  discipline as Phase 3 blocking over-receiving.

- `boms` (one active recipe per output item — a partial unique index, not a
  version history; editing replaces its component set wholesale rather
  than diffing rows) + `bom_components` (item + quantity, scaled per
  `boms.output_qty` — a "batch size" the recipe is written against, not
  necessarily 1).
- `record_bom_production()`, a security-definer RPC and the *only* way
  `bom_production_runs` rows are ever created (deliberately no direct
  insert policy on that table) — atomically checks every component against
  `current_stock`, and either writes the production run plus a matching
  "out" `stock_movements` row per component and an "in" row for the output
  item, or writes nothing and raises an exception naming exactly which
  components are short. Known, documented limitation: two concurrent
  production runs racing on the same shared component could both pass the
  check before either writes (no per-item locking) — judged an acceptable
  gap for this app's scale rather than worth advisory-lock complexity.
- `src/screens/bomBuilder.js` (Admin/Production — the only two roles with
  access to this screen at all, per `navPermissions.js`, so every visitor
  already has manage rights; action buttons are still gated on that
  role check locally too, matching this app's usual double-enforcement):
  a recipe list, each row expandable into its component table, a "Record
  Production" mini-form, and its production history; "+ New Recipe"/Edit/
  Archive, plus a quick "+ New Item" for when the item a recipe needs
  doesn't exist yet in the Item Master.

### Phase 6 — open items

1. **Production/staging schema**: confirmed applied to both staging (CI's
   `integration` job passes) and production.
2. **Design mockup**: still not available.
3. **Deactivating your own last admin account** (carried over from Phase
   1): still not guarded against.

## Phase 7 — Work Orders (nested BoM explosion + stock reservation)

Confirmed three design decisions before building (no mockup):

- **Explosion nets against available stock at every level, not just the
  leaves** — standard MRP netting. If there's already enough of a
  sub-assembly on hand, its own recipe is never exploded further; only the
  shortfall at each level propagates down into that item's components.
- **Reservation is a hard hold.** Reserved units are subtracted from
  "available" everywhere — a new `available_stock` view
  (`current_qty - reserved_qty`) replaces `current_stock` as what
  Inventory (Phase 4) displays, and it's what both `explode_bom_requirements`
  and Phase 6's `record_bom_production()` now check against, so a second
  work order (or a BoM production run) can't also plan against the same
  units.
- **This phase stops at plan + reserve.** Completing/fulfilling a work
  order (cascading it into an actual production run) is out of scope —
  that still happens one recipe at a time via Phase 6's BoM Builder; a
  work order here is a plan with stock held against it, not a production
  run. Cancelling one just releases the hold.

- `explode_bom_requirements(item, qty)`: a recursive, level-by-level
  (breadth-first) netting walk over `boms`/`bom_components`, returning
  per-item `reservable_qty` (what's on hand right now) and `shortfall_qty`
  (what isn't, anywhere in the tree). Known, documented limitation: the
  *same* item reachable at two different depths in a nested BoM can have
  its stock netted more than once across those depths (true low-level-code
  MRP would defer every item to its single lowest occurrence first; this
  doesn't) — judged out of scope for this app's real recipes. Critically
  this can only make the *preview* optimistic, never unsafe:
  `reserve_work_order()` re-checks the aggregated total against the item's
  one true `available_qty` before committing anything, so an inflated
  preview gets rejected at reserve time rather than ever over-reserving
  real stock.
- `work_orders` (status `open`/`reserved`/`cancelled`) + a
  `work_order_requirements` snapshot taken once at creation time (not
  recomputed live) + `stock_reservations` (the actual holds, created only
  by `reserve_work_order()`). Both `create_work_order()` and
  `reserve_work_order()` are security-definer RPCs and the only way in —
  same "the RPC is the only way in" pattern as Phase 6's
  `bom_production_runs` — while cancelling is a plain client update, gated
  by RLS to only ever permit the `cancelled` transition.
- `src/screens/workOrders.js` (Admin/Production/Store): pick an item +
  quantity, "Check Availability" for a live preview before saving, create
  the work order, then per-order "Reserve Stock" / "Cancel Work Order" and
  an expandable detail view of its requirement snapshot.
- Inventory (Phase 4) now shows Reserved/Available columns alongside
  Current Stock, and its "below reorder" flag compares against `available_qty`
  instead of `current_qty` — a natural, minimal extension of that screen
  caused directly by this phase's reservation model, not a re-scoping of
  Phase 4.

### Phase 7 — open items

1. **Production/staging schema**: confirmed applied to both staging (CI's
   `integration` job passes) and production.
2. **Design mockup**: still not available.
3. **Deactivating your own last admin account** (carried over from Phase
   1): still not guarded against.

## Phase 0 — resolved

Design mockup and Vercel/Supabase creation are still open per above; the
rest of Phase 0's open items (role list, new-account role) were resolved —
role list confirmed as proposed, and a role-less account intentionally sees
almost nothing until an admin assigns a role (see item 2 above).
