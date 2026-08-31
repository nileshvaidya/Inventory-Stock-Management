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

## Phase 3: Material Inward, Inspection, Master Material Status

Confirmed two design decisions before building (no mockup, and these
shape the data model): a PO's status only shows `rejected` when the
**entire** order was rejected — a partial rejection stays
`received_inspected` — and Master Material Status shows one row per PO
line item, not a per-PO rollup.

- `supabase/schema.sql`: `material_inward` (one row per delivery — a PO can
  be received across multiple partial deliveries) and
  `material_inward_line_items` (received qty per PO line item per
  delivery); `inspection_results` (one row per received line item,
  Accepted/Rejected qty, `rejection_reason` required whenever any quantity
  is rejected — a DB check constraint, not just form validation);
  `is_store_or_admin`/`is_inspector_or_admin` security-definer helpers
  mirroring `is_purchase_or_admin`.
- `recompute_po_status()` + triggers on all three new tables:
  `purchase_orders.status` is no longer written directly by the app for
  these transitions — it's recalculated automatically from the underlying
  received/accepted/rejected quantities on every relevant write, so it
  can't drift from reality regardless of which screen touched the data.
- `master_material_status`: a Postgres view (not a table), one row per PO
  line item with Ordered/Received/Accepted/Rejected/Pending quantities —
  a plain view inherits the same company-wide read RLS already on the
  tables it joins, no separate policy needed. Reused by the Material
  Inward screen itself to show "already received" per line item, so the
  two screens can never disagree about the running total.
- `src/screens/materialInward.js` (Store/Admin): select a PO still pending
  receipt, log a "Receiving Now" quantity per line item (capped to what's
  actually pending), Received Date + Notes, and an inward history table
  per PO.
- `src/screens/inspection.js` (Inspector/Admin): lists received line items
  with no inspection yet; inspecting one requires Accepted + Rejected to
  exactly account for the received quantity, with a reason mandatory for
  any rejection.
- `src/screens/masterMaterialStatus.js` (Admin/Purchase/Store/Inspector,
  read-only): Project/Status filters, CSV export.
- `src/validation.js`: `validateInwardLineItem`/`validateInwardForm`
  (received qty must be positive and can't exceed what's pending) and
  `validateInspectionForm` (accepted+rejected must equal received qty; a
  rejection reason is required whenever anything is rejected).
- `scripts/test-rls-material-inward.mjs` (new, added to
  `npm run test:integration`): store/inspector write permissions on the
  new tables; the full `recompute_po_status` lifecycle end to end —
  partial receipt → complete receipt → mixed accept/reject inspection
  (stays `received_inspected`) → a second PO fully rejected (`rejected`);
  the DB-level "no reason, no rejection" check constraint; and
  `master_material_status`'s numbers matching what was actually entered.
- `e2e/phase3.spec.js`: route guards for all three screens, a full
  Material Inward save + a validation-blocks-save case, a full Inspection
  save (partial accept/reject with a reason) + a validation-blocks-save
  case, and Master Material Status rendering + CSV export + empty state.

## Phase 4: Inventory (Item Master + stock movement ledger)

Confirmed two design decisions before building: PO Upload gets an Item
selector (rather than matching free-text item names, which is fragile),
and accepted inspections auto-create an inbound stock movement (rather
than starting with manual entries only) — so "current stock" reflects
real receiving activity without a separate re-entry step.

- `supabase/schema.sql`: `items` (Item Master: name, category, unit of
  measure, reorder level) and `stock_movements` (the ledger: item,
  in/out, quantity, an optional reference type/id, notes) —
  `can_manage_items` (purchase/store/admin) gates `items` writes, since
  both PO Upload and the Inventory screen create items;
  `is_store_or_admin` (already existed from Phase 3) gates manual
  `stock_movements` writes. `po_line_items.item_id` is a new nullable FK
  — additive, so existing rows keep their free-text `item_name` only and
  simply don't feed the ledger.
- `trg_stock_in_from_inspection`: a security-definer trigger on
  `inspection_results` that inserts a matching `stock_movements` row
  (`in`, `quantity = accepted_qty`, `reference_type = 'inspection'`)
  whenever an inspection accepts anything for a line item that has an
  Item linked — an inspector's own action needs no direct
  `stock_movements` grant, same rationale as `recompute_po_status`.
  Fires on insert only; documented as a known limitation that a later
  correction via `UPDATE` on `inspection_results` doesn't retroactively
  adjust stock.
- `current_stock`: a view (`qty_in`/`qty_out`/`current_qty` per item,
  joined with `reorder_level`) — same "plain view inherits the
  underlying tables' RLS" pattern as `master_material_status`.
- `src/screens/poUpload.js`: each line item row gets a "Linked Item"
  dropdown, plus an inline "+ New Item" (same UX as Project/Vendor) near
  the Line Items header. Optional — unlinked rows still save fine with
  just their item name.
- `src/screens/inventory.js` (Admin/Store/Production): current stock,
  filterable by name/category/below-reorder-only; each row expands into
  its full movement ledger. "+ New Item" and manual "Log Movement" are
  Store/Admin only, enforced by RLS server-side, not just hidden from
  Production in the UI.
- `src/validation.js`: `validateItemForm` (name required, everything else
  optional), `validateStockMovementForm` (item + in/out + positive qty).
- `scripts/test-rls-inventory.mjs` (new, added to `npm run
  test:integration`): item-creation permissions per role; the
  auto-stock-in trigger firing with the correct quantity/reference on an
  accepted inspection; `current_stock`'s numbers matching a real
  auto-in + manual-out sequence; manual movement permissions per role.
- `e2e/phase4.spec.js`: route guard, stock list + below-reorder flag +
  ledger view, a store-role manual movement, Production's read-only
  affordances, new-item creation, and an empty state. Added a
  `production` demo user (`src/demoMode.js`) since Phase 4 was the first
  screen needing to exercise that specific role in a browser test.
  `e2e/phase2.spec.js` also gained a Phase 4 case (new item + linking a
  PO line item to it, verifying `item_id` reaches the save payload) and
  had its `items` lookup mocked into `mockEmptyLookups` and one
  custom-route test, since PO Upload's `loadLookups` now also fetches
  Items.

## Phase 5: Invoices (multi-PO linking, payment terms/due dates, overdue)

The first module in this schema whose RLS restricts read, not just write,
to a narrow pair — Invoices is Admin/Authorized end to end, since no other
role has a stated need to see invoice/payment-term data (unlike Phase
2-4's tables, which stayed company-wide readable even where writes were
role-restricted).

- `supabase/schema.sql`: `is_authorized_or_admin` (mirrors
  `is_purchase_or_admin`/`is_store_or_admin`); `invoices` (invoice number,
  vendor, invoice date, payment terms days, due date, amount, `paid_at`,
  notes, soft-deletable) and `invoice_purchase_orders` (a many-to-many
  junction — one invoice can cover several POs, and a PO could in
  principle be split across more than one invoice). "Overdue" is computed
  (`paid_at is null and due_date < today`), not stored — using a nullable
  `paid_at` timestamp rather than a boolean means an invoice paid after
  its due date correctly stops showing as overdue as soon as it's marked
  paid, instead of staying flagged forever.
- `src/screens/invoices.js` (Admin/Authorized): Vendor/Status
  (Pending/Overdue/Paid) filters, CSV export, "+ New Invoice" (Payment
  Terms auto-fills from the selected vendor's `default_payment_terms_days`
  and Due Date auto-computes from Invoice Date + Payment Terms — both
  still directly overridable — plus a checklist to link one or more of
  that vendor's POs), "Mark Paid" and archive per row.
- Confirmed as a self-contained assumption, not a retrofit needing a
  separate confirmation round: marking an invoice paid lives in Phase 5
  itself rather than being deferred entirely to Phase 10's Bill Payments,
  since "overdue" needs a real paid/unpaid lifecycle to mean anything —
  Phase 10 may supersede or extend this once it lands.
- `src/validation.js`: `validateInvoiceForm` (vendor + invoice date +
  non-negative amount required; linked POs optional).
- `scripts/test-rls-invoices.mjs` (new, added to `npm run
  test:integration`): create/read/mark-paid/archive permissions per role,
  plus confirming the narrow-read RLS actually filters (not errors) for
  an excluded role — the first table in this schema where read itself is
  restricted, not company-wide.
- `e2e/phase5.spec.js`: route guard, creating a linked invoice with
  due-date auto-fill, a validation-blocks-save case, status
  rendering (paid/overdue) + Mark Paid, and an empty state.

## Fix: flaky e2e test — route mock matched on URL substring, not path

`e2e/phase3.spec.js`'s "logs a receipt..." test intermittently failed: its
mock for `material_inward` checked `url.includes('material_inward_line_items')`
against the *full* request URL, but `fetchInwardHistory()`'s own GET
against the plain `material_inward` table embeds
`line_items:material_inward_line_items(...)` in its `?select=` query
param — so that unrelated background-refresh GET matched the same branch
as the real POST, intermittently overwriting the captured POST body with
`null` depending on request timing. Fixed to match on the URL's *path*
(`new URL(url).pathname.endsWith(...)`) instead of a full-URL substring
check. Verified with 10 repeated runs of the affected test, plus two full
local suite runs.

## Phase 6: BoM Builder (nested bills of materials + recording production)

Confirmed two design decisions before building: recording production
consumes only a recipe's own direct components, one level — Phase 7 (Work
Orders) is described as the layer that explodes a multi-level BoM tree to
check/reserve availability further down, so Phase 6 doesn't duplicate that
— and a stock shortfall on any component blocks the whole production
record (nothing written) rather than letting stock go negative, same
discipline as Phase 3's over-receiving guard.

- `supabase/schema.sql`: `can_manage_boms` (admin/production); `boms`
  (one active recipe per output item via a partial unique index — editing
  replaces its component set wholesale rather than versioning) and
  `bom_components` (item + quantity, scaled per `boms.output_qty`, a
  "batch size" the recipe is written against). A BoM's structure is
  itself nested (a component can be an item with its own recipe), so a
  trigger (`bom_cycle_would_exist`, a recursive CTE) blocks both direct
  self-reference and any deeper circular reference at write time — not
  just at explosion time, which is Phase 7's job.
- `record_bom_production()`: a security-definer RPC and the *only* way
  `bom_production_runs` rows are created (deliberately no direct insert
  policy on that table). Atomically checks every component against
  `current_stock` and either writes the production run plus a matching
  "out" `stock_movements` row per component and an "in" row for the
  output item, or writes nothing and raises an exception naming exactly
  which components are short. Documented limitation: two concurrent
  production runs racing on the same shared component could both pass the
  check before either writes (no per-item locking) — an accepted gap for
  this app's scale rather than added advisory-lock complexity.
- `src/screens/bomBuilder.js` (Admin/Production — the only two roles with
  access to this screen at all): recipe list, each row expandable into its
  component table, a Record Production mini-form, and production history;
  create/edit/archive a recipe, plus a quick "+ New Item" for a component
  that doesn't exist in the Item Master yet.
- `src/validation.js`: `validateBomForm` (output item + positive output
  quantity + at least one valid, non-duplicate component that isn't the
  output item itself — the same rule the DB trigger enforces, checked
  here first), `validateBomComponentRow`, `validateProductionForm`.
- `scripts/test-rls-boms.mjs` (new, added to `npm run test:integration`):
  create/read/archive permissions per role, the self-reference and
  circular-reference trigger rejections, `record_bom_production()`'s
  shortfall rejection (and that nothing is written when it's rejected),
  its success path (component consumed, output credited, exactly one run
  recorded), role rejection on the RPC, and that a direct insert into
  `bom_production_runs` is blocked.
- `e2e/phase6.spec.js`: route guard, creating a recipe with two
  components, a validation-blocks-save case (component = output item),
  viewing a recipe's details and recording production (verifying the RPC
  call body and the refreshed history), the server-side shortfall message
  surfacing in the UI, archiving a recipe, and an empty state.

## Phase 7: Work Orders (nested BoM explosion + stock reservation)

Confirmed three design decisions before building: explosion nets against
available stock at every level (not just the leaves — if there's already
enough of a sub-assembly on hand, its own recipe never gets exploded
further); reservation is a hard hold that reduces "available" everywhere,
not a soft note scoped to the work order; and this phase stops at plan +
reserve, leaving actual production recording to Phase 6's BoM Builder.

- `supabase/schema.sql`: `can_manage_work_orders` (admin/production/store);
  `work_orders` (status open/reserved/cancelled), `work_order_requirements`
  (a snapshot of the exploded/netted requirement per item, taken once at
  creation time), `stock_reservations` (the actual holds). Both
  `work_orders` and `work_order_requirements` have no direct insert
  policy — created only via `create_work_order()` — and `stock_reservations`
  only via `reserve_work_order()`, same "the RPC is the only way in"
  pattern as Phase 6's `bom_production_runs`. Cancelling is a plain client
  update instead, gated by RLS to only ever permit the `cancelled`
  transition (a trigger stamps `cancelled_at`).
- `available_stock`: `current_stock` netted against every *active*
  (`status = 'reserved'`) reservation — cancelling a work order frees its
  hold automatically since the join drops out, without ever deleting the
  `stock_reservations` audit rows.
- `explode_bom_requirements(item, qty)`: a recursive, level-by-level
  (breadth-first) netting walk, returning per-item `reservable_qty`
  (on hand right now) and `shortfall_qty` (not covered anywhere in the
  tree). Documented limitation: the same item reachable at two different
  depths in a nested BoM can have its stock netted more than once (true
  low-level-code MRP would defer every item to its single lowest
  occurrence first) — but this can only ever make the *preview*
  optimistic, never unsafe, since `reserve_work_order()` re-checks the
  aggregated total against the item's one true `available_qty` before
  committing anything.
- `create_work_order()` inserts the work order plus its requirement
  snapshot atomically. `reserve_work_order()` re-checks availability
  against the *current* `available_stock` (not the creation-time
  snapshot) before committing, and blocks (nothing written) if anything
  has become unavailable since — same all-or-nothing discipline as
  Phase 6's `record_bom_production()`.
- `src/screens/workOrders.js` (Admin/Production/Store): pick an item +
  quantity, "Check Availability" for a live preview, create the work
  order, then per-order Reserve/Cancel actions and an expandable
  requirement snapshot.
- Inventory (Phase 4) now reads `available_stock` instead of
  `current_stock`, showing Reserved/Available columns and comparing
  "below reorder" against `available_qty` — a minimal, necessary
  extension caused directly by this phase's reservation model.
- `src/validation.js`: `validateWorkOrderForm`.
- `scripts/test-rls-work-orders.mjs` (new, added to `npm run
  test:integration`): the netting explosion's math (including a shortfall
  case), create/reserve/cancel permissions per role, that a direct insert
  into any of the three new tables is blocked, the reservation's effect
  on `available_stock`, reserving an already-reserved work order failing,
  and a direct client update being unable to forge a `reserved` status
  transition.
- `e2e/phase7.spec.js`: route guard, previewing an explosion and creating
  a work order (verifying both RPC call bodies), a validation-blocks-save
  case, viewing a work order's requirements and reserving stock for it,
  the server-side shortfall message surfacing on a blocked reserve,
  cancelling, and an empty state. `e2e/phase4.spec.js` updated to mock
  `available_stock` instead of `current_stock`.
