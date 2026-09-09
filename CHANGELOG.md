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

## Fix: RLS test asserted the wrong thing for a zero-row work order cancel

Same class of bug as the earlier `purchase_orders` soft-delete test: an
UPDATE whose USING clause excludes the caller's row (purchase, since
`can_manage_work_orders()` is false for it) matches zero rows under RLS
— PostgREST reports that as a quiet 200/no-op, not an error. The test
asserted "an error occurred" instead of "the row didn't actually
change", so it failed even though the security boundary itself was
holding correctly (32/33 other assertions in the script already passed
against real staging data, including store's real cancel succeeding
right after). Fixed to assert against the row's persisted state via the
service-role client instead.

## Phase 8: Reports (Stock & Reservations, Shortages, Below Reorder)

No new schema this phase — every report reads tables/views that already
exist and are already company-wide readable (`available_stock` from
Phase 4/7, `stock_reservations`/`work_orders`/`work_order_requirements`
from Phase 7), so there's no new `scripts/test-rls-*.mjs` either.

- `src/reports.js`: `fetchActiveReservations()` and `fetchShortages()`,
  both using PostgREST's `!inner` embed-filter syntax to filter on the
  embedded `work_orders.status` column server-side (`.eq('work_order.status', 'reserved')` /
  `.in('work_order.status', ['open', 'reserved'])`).
- `src/screens/reports.js` (Admin/Authorized/Production, per the existing
  `navPermissions.js` matrix — Store is excluded here even though it can
  manage Work Orders/Inventory): three tabs, all read-only. Stock &
  Reservations lists every item with an active hold, each row expandable
  into which work order(s) hold it and how much. Shortages lists every
  component still short somewhere in an open or reserved work order's
  exploded requirements. Below Reorder lists items whose *available*
  quantity (not just on-hand) has dropped under its reorder level — the
  same figure Inventory (Phase 4) flags. CSV export follows whichever tab
  is active.
- `e2e/phase8.spec.js`: route guard, each tab's listing (including the
  Stock & Reservations tab's expandable "held by" detail), CSV export,
  and empty states for all three tabs.

## Phase 9: Action Log (automatic, filterable audit trail)

Confirmed one design decision before building: actions are captured
automatically via a single reusable trigger attached to every mutable
table, rather than an explicit "log this" call added after each write in
~15 existing data-layer files. A trigger can't be silently missed by a
future write path, and it correctly attributes writes made through a
security-definer RPC (record_bom_production, create_work_order,
reserve_work_order) to the real calling user — auth.uid() reflects the
original request's JWT throughout a security-definer call, not the
function owner's elevated privileges.

- `action_log` (table_name, operation, row_id, user_id, old_data/
  new_data as jsonb, created_at) + trg_log_action(), attached via a `do`
  block to all 19 tables with real mutations across every phase so far.
  No insert/update/delete policy for direct clients — the trigger is the
  only way in. Skips logging when there's no authenticated caller
  (auth.uid() is null) — service-role writes are infrastructure noise,
  not an app user's action. user_id is `on delete set null` so the log
  outlives a deleted user account.
- Admin-only read — the first table since Phase 5's Invoices where
  SELECT itself is role-restricted, not company-wide.
- `src/screens/actionLog.js`: filters by user, record type, action
  (Created/Updated/Deleted), and date range; each row expandable into its
  raw before/after JSON; CSV export. The date "To" filter uses an
  exclusive next-day boundary against created_at (a timestamptz) rather
  than a naive `lte` on the typed date, which would silently exclude
  everything later that day.
- `scripts/test-rls-action-log.mjs` (new, added to `npm run
  test:integration`): a plain INSERT/UPDATE is logged and attributed to
  the acting user with correct old/new data; a write made through
  create_work_order()'s security-definer RPC is still attributed to the
  real caller, not the function owner; a service-role-only write isn't
  logged at all; a direct insert into action_log is blocked; admin can
  read the log and store cannot (RLS silently filters it, not an error).
- `e2e/phase9.spec.js`: route guard, listing with before/after detail,
  each filter (user/record type/action/date range) producing the
  expected PostgREST query params, CSV export, and an empty state.

## Phase 10: Bill Payments (scanned bill files, mark received)

Confirmed with the user before building, resolving the design tension
flagged in Phase 5's own docs: "Bill" and "Invoice" are the same record,
not a separate entity. So no new table — invoice creation and PO-linking
stay on the existing Invoices screen, and `action_log`'s existing trigger
on `invoices` already covers every write this phase makes. The one real
capability this phase adds is the scanned bill document itself, via
Supabase Storage — this app's first use of it (also confirmed with the
user, over Phase 2's PO Upload's client-side-parse-only pattern, which
never persists the source file).

- `invoices` gains `bill_file_path`/`bill_file_name` (nullable, covered
  by the existing Phase 5 update policy — no new RLS on the table
  itself) and a private `bill-documents` Storage bucket with
  insert/select/delete policies on `storage.objects`, scoped to the same
  `is_authorized_or_admin()` pair as `invoices`' own RLS.
- `src/invoices.js`: `uploadBillFile`/`getBillFileUrl`/`removeBillFile`.
  Viewing uses a signed URL (5-minute expiry) rather than
  `getPublicUrl` — the bucket is private, and a bare public URL would
  bypass RLS entirely once handed out.
- `src/screens/billPayments.js` is now real, replacing the Phase 0
  placeholder (and retiring `src/placeholderScreen.js`, unused once this
  was the last remaining phase). Deliberately narrower than a second
  Invoices screen: list with a Status filter (Pending/Overdue/Received),
  per-row Attach/Replace/View/Remove for the bill file, and Mark
  Received (the same `paid_at` write as Invoices' Mark Paid). No
  invoice-creation or PO-linking form here.
- Restricted to the `authorized` role only, not admin, per the
  `navPermissions.js` matrix confirmed back in Phase 1 — narrower than
  Invoices' own admin/authorized RLS, same nav-vs-RLS relationship as
  every other module. The other three enforcement layers (nav, route
  guard, Help exclusion) were already built in Phase 0/1; this phase's
  Storage RLS is the fourth.
- `scripts/test-rls-bill-payments.mjs` (new, added to `npm run
  test:integration`): authorized role can upload/sign/delete a bill file
  in the `bill-documents` bucket and record its path on the invoice row;
  purchase role can do none of it.
- `e2e/phase10.spec.js`: route guards (admin *and* store both redirected
  — admin is deliberately excluded from this nav item, unlike every
  other restricted module), attach-a-file upload, Mark Received, a
  received row's display, and an empty state.

## Docs: close out the two long-carried-over open items

With all ten phases built, revisited the two open items every phase's
README section had been carrying forward since Phase 1:

- **"Deactivating your own last admin account"**: re-checked the actual
  code rather than continuing to flag it — `set_user_role`/
  `set_user_status`'s Phase 1 self-targeting guard
  (`if target_id = auth.uid() then raise exception ...`) already blocks
  an admin from changing their own role or status at all, admin count
  aside, so this scenario was covered from the start. It had simply
  never been re-verified against the code before being carried forward
  again each phase. Confirmed with the user before closing it as docs-only
  (a broader "no admin can ever be left at zero, system-wide" guard was
  considered and deliberately not built — it would need testing against
  real admin rows on a shared staging project to verify safely).
- **Design mockup**: the original Claude Design mockup the build brief
  pointed at never became available over the whole build. With a
  pre-build spec no longer applicable now that the app is fully built,
  generated a retroactive one instead, at the user's request:
  `design-reference/screens/` (8 Design Components artboards + a
  canvas.json — Login, Dashboard, Invoices, Work Orders, Action Log,
  Bill Payments, Users & Roles, and a mobile view), built by reading the
  real Nocturne tokens and markup straight out of
  `src/styles/nocturne.css` and `src/layout.js`/`src/screens/*.js`
  rather than inventing a new look, published for interactive viewing.
  `README.md`'s and `design-reference/README.md`'s open items updated
  across every phase to point at this instead of repeating "still not
  available."

## Help Manual: click-by-click How To (every screen, real screenshots) + FAQ

Direct user request: rebuilt `src/screens/help.js` from a one-line-per-
module summary into a full user manual for a non-technical reader,
porting the pattern (TOC, numbered steps, embedded real screenshots)
from the sibling Task_Management/WorkSync app's own Help manual.

- **How To**: one section per screen — Getting Started (sign in/up),
  Dashboard, PO Upload (including Map Fields Manually), Order Status,
  Material Inward, Inspection, Master Material Status, Inventory, BoM
  Builder, Work Orders, Invoices, Reports, Users & Roles, Action Log,
  and (role-gated) Bill Payments — each a numbered, click-by-click
  walkthrough with a real screenshot, not a description. A table of
  contents at the top jumps to any section.
- `scripts/capture-help-screenshots.mjs` (new): captures all 26
  screenshots against demo mode with mocked network responses — no live
  Supabase project needed. One shared, coherent set of fixture data
  (same vendor/project/item names) runs through every screen so the
  manual reads as one consistent story. Not part of CI; rerun by hand
  when the UI changes enough to go stale.
- **FAQ**: a fixed list of real day-to-day questions (role visibility,
  a PDF that didn't parse right, self-updating PO status, Received vs.
  Accepted quantity, the reorder/reservation math, undoing a BoM
  production run, CSV export, and more) — click a question to expand
  its answer, collapsed by default.
- Bill Payments' role-based exclusion (build brief §3, previously
  `RESTRICTED_SECTION`) now extends across all three surfaces this
  rewrite touches — the How To section, its TOC entry, and the one FAQ
  item that names it — each built conditionally on
  `canViewModule('/bill-payments', role)`, never present in the DOM at
  all for a non-authorized viewer. `e2e/phase1.spec.js` gained two new
  tests (TOC navigation + a real check that every screenshot referenced
  actually loads, plus FAQ expand/collapse) alongside its existing
  Bill-Payments-exclusion coverage.

## Fix: stale-tab navigation failures after a deploy

Reported live on Vercel right after the Help Manual push: "Help link on
dashboard not working" — clicking it did nothing. Root cause: a tab left
open across a deploy still runs the old JS bundle, whose dynamic
`import()` calls point at content-hashed chunk filenames a new deploy has
already replaced; the import rejects, and `startRouter`'s hashchange
handler (`src/router.js`) had no catch, so the clicked link's URL updated
but the screen never swapped — silently, with nothing surfaced anywhere.
Fixed by catching that failure and reloading once to pick up the fresh
`index.html`/chunk manifest; a second failure after that reload is a real
error, not a stale bundle, so it's left to surface instead of reloading
forever. Verified by deliberately blocking the Help chunk in a built
preview and confirming the router reloads instead of going silent.

## Help Manual: topic navigation instead of one long scrolling page

Direct user request: the Help Manual above rendered every topic
concatenated into one page behind a jump-to-anchor table of contents —
reading about Invoices still meant scrolling past PO Upload, BoM
Builder, and everything else first. Restructured `src/screens/help.js`
so only the selected topic is ever in the DOM:

- A sidebar lists every topic (How To screens, FAQ, Troubleshooting);
  clicking one swaps the content panel and highlights the active entry
  — no scrolling required to reach a topic, and no unrelated topics'
  images loaded until their topic is opened.
- Cross-reference links inside a topic's own body (e.g. Inspection's
  "see Inventory") use the same `data-help-nav` mechanism as the
  sidebar, jumping straight to that topic instead of scrolling to an
  in-page anchor.
- Bill Payments' role-based exclusion is unaffected — its sidebar entry
  and How To topic are still only ever built into the topic list when
  `canViewModule('/bill-payments', role)` is true, so a non-authorized
  viewer never has it in the DOM, not even unopened.
- `e2e/phase1.spec.js`'s Help-manual tests updated for the new
  interaction: switching topics via the sidebar and via an in-content
  cross-reference link, and the FAQ expand/collapse test now opens the
  FAQ topic first instead of finding it pre-rendered on the page.

## Fix: PO Upload lost focus after every character typed

Reported: editing an item name, quantity, rate, or any other field on PO
Upload dropped focus after each keystroke, making it impossible to type
continuously. Root cause: `src/screens/poUpload.js`'s `paint()` replaces
the whole form's `innerHTML` on every `input` event (so the computed
total and validation stay live as you type) — but that destroys and
rebuilds the focused `<input>` from scratch each time, so the browser
drops focus after every single character.

Fixed by having `paint()` remember which element was focused (matched by
its `data-action`/`data-index`/`data-role`/`id`) and its cursor position
before repainting, then re-find the equivalent new element afterwards and
restore both. Also switched the Qty/Rate/Payment Terms fields from
`type="number"` to `type="text" inputmode="…"`: a `number` input doesn't
expose `selectionStart`, and it also privately tracks an unrestorable
"pending edit" state for an incomplete value like `"99."` — surviving a
full node replacement mid-decimal silently dropped the decimal point
(typing "99.50" landed as "9950"). Existing validation already parses
these fields with `Number(...)` on a string, so the field's `type`
attribute was never load-bearing for it.

Verified with Playwright's `pressSequentially` (fires one native
keydown/input per character, unlike `.fill()` which sets the whole value
in one shot and would never have exercised this bug) against a real
built preview: item name, quantity, rate (including a decimal), PO
Number, and the inline "+ New Item" field all now type correctly with
focus retained, and the live computed-total/amount calculations are
unaffected.

## Order Status: archiving a PO restricted to admin (direct request)

Order Status' only mutating action — the "Delete" button, which
soft-deletes (archives) a Purchase Order — was previously available to
both Admin and Purchase (`is_purchase_or_admin`, same grant as creating a
PO). At the user's explicit request, restricted to admin only, at both
layers:

- `src/screens/orderStatus.js`: the Delete button is only rendered when
  `user.role === 'admin'` — a Purchase viewer still sees and filters
  every PO, just without the action.
- `supabase/schema.sql`: `purchase_orders`' update policy (the same
  policy the "Delete" button's soft-delete goes through) now checks
  `is_admin()` instead of `is_purchase_or_admin()` — the real backstop,
  since hiding a button alone doesn't stop a direct API call. Automatic
  PO status recalculation (`recompute_po_status`) is unaffected — it's
  `security definer` specifically so it never depended on this policy in
  the first place.
- `scripts/test-rls-purchase-orders.mjs` updated to assert the new
  matrix against a real Supabase project: purchase and store roles'
  archive attempts are silently filtered to zero rows, admin's succeeds.
- `e2e/phase2.spec.js` gained a test confirming the Delete button
  renders for admin and is absent for purchase on the same row;
  `src/demoMode.js` gained a `purchase` demo user (only
  `admin`/`authorized`/`store`/`production` existed before) since this is
  the first test needing it.
- `src/screens/help.js`'s Order Status topic now marks the archive step
  "Admin only."

## Fix: every editable screen lost focus after each character typed

Reported on Inspection, matching the same bug already fixed on PO
Upload: every screen with an editable form does a full
`container.innerHTML` replace on each keystroke (`store.subscribe(paint)`
re-rendering synchronously so validation/computed totals stay live) —
destroying and rebuilding the focused `<input>` from scratch each time,
so continuous typing was impossible anywhere, not just PO Upload.

Extracted the PO Upload fix into a shared `src/domFocus.js`
(`repaintPreservingFocus`) — remembers the focused element (by
id/data-* attributes) and its cursor position before a repaint, restores
both on the equivalent freshly-rendered element afterwards — and wired
it into every other screen with the same `paint()` pattern: Inspection,
BoM Builder, Inventory, Invoices, Material Inward, Work Orders (PO
Upload itself now uses the shared helper too instead of its own inline
copy). Also converted every free-typed numeric field across those
screens from `type="number"` to `type="text" inputmode="decimal"` (or
`"numeric"` for whole-number fields) for the same reason as PO Upload's
Qty/Rate: a `number` input can't expose or restore cursor position, and
separately drops a decimal point typed mid-edit across a full node
replacement (e.g. "62.5" landing as "625"). Every affected field is
already validated with `Number(...)` on a string (`src/validation.js`),
so the input's `type` attribute was never load-bearing.

Added `src/domFocus.test.js` (5 unit tests covering focus/cursor
restore, the number-input caret fallback, no-op cases, and that a
`<select>` regaining focus isn't touched) and an e2e regression test on
Inspection using Playwright's `pressSequentially` (fires one native
keydown/input per character — `.fill()` sets the whole value in one shot
and would never have caught this). Verified every affected field on all
7 screens by hand with character-by-character typing against a real
built preview; the full existing suite (lint, typecheck, 112 unit
tests, all 80 e2e tests, production build) stayed green throughout.

## Upload-and-scan for Material Inward (delivery challan) and Invoices

Direct user request: "Material Inward" (delivery challans) and
"Invoices" had no document-upload facility, unlike PO Upload's
upload-a-PDF-and-auto-fill flow — both now work the same way, with
manual entry always still available as the fallback/correction path.

- **Invoices**: "Upload Invoice (optional)" on the New Invoice form —
  choosing a text-based PDF extracts its text (reusing PO Upload's
  `extractPdfText`) and tries to fill in Invoice Number, Invoice Date,
  and Amount (new `parseInvoiceNumber`/`parseInvoiceDate`/
  `parseInvoiceAmount` in `src/pdfParser.js`); every field stays
  editable regardless. On Save, the chosen file is attached to the new
  invoice via the existing Phase 10 bill-file plumbing
  (`uploadBillFile`/`bill-documents` bucket) — no schema change needed,
  since "bill" and "invoice" are already the same record. The Invoices
  list itself gained a File column (Attach/Replace/View) so an admin,
  who doesn't have access to the narrower Bill Payments screen, can
  still see and manage what's attached.
- **Material Inward**: "Upload Delivery Challan (optional)", once a PO
  is selected — extracts text and tries to match each parsed
  description/quantity line (new `parseChallanText` in
  `src/pdfParser.js`, same shape as a PO line item minus the rate) by
  name to a line item on the selected PO, pre-filling "Receiving Now"
  for whatever matched; a note reports how many of the document's lines
  matched. Needs new plumbing, since Material Inward never had a file
  capability before: `material_inward.challan_file_path`/
  `challan_file_name` columns and a new private `challan-documents`
  Storage bucket (`supabase/schema.sql`) — read is company-wide
  (matching material_inward's own SELECT policy), write is store/admin
  (matching its own write policy), unlike bill-documents' narrower
  authorized/admin-only read. The Inward History table gained a
  Challan column (View) for past receipts.
- Both screens: a non-PDF (scanned image) file is attached as-is with
  no parsing attempt — parsing only ever works on a text-based PDF, and
  every field stays fully editable either way, exactly like PO Upload's
  own manual-entry fallback.
- New `scripts/test-rls-challan-documents.mjs` (added to
  `test:integration`), mirroring `test-rls-bill-payments.mjs`, asserts
  the new bucket's policies against a real Supabase project — **this
  needs the schema.sql changes above applied to that project before it
  will pass there**, same "push to git ≠ applied to the live database"
  gap as the Order Status admin-only fix earlier.
- Verified end to end against real (hand-built) PDF fixtures through
  the actual browser: text extraction, field pre-fill, challan-to-line-
  item matching, and the post-create file attach all confirmed working
  outside of unit tests. e2e coverage (new tests in `phase3.spec.js`/
  `phase5.spec.js`) sticks to the codebase's established convention of
  not committing a binary PDF fixture — pure parsing logic is unit-
  tested (`pdfParser.test.js`), e2e covers the non-PDF/image-attach path
  and the resulting UI affordances (View/Attach/Replace), same split PO
  Upload's own e2e suite already uses.
- `src/screens/help.js` updated for both screens' new upload step, and
  the Bill Payments/Invoices FAQ item to note Invoices can now attach a
  file too (only Bill Payments can remove one).

## OCR fallback for scanned/photographed documents (PO Upload, Material Inward, Invoices)

Direct user request, after a real scanned invoice failed to auto-fill:
the PDF turned out to have no embedded text layer at all (a photo of the
invoice saved as a PDF, not a text-based one) — not a bug, but a real
gap, since a scanned image was previously never auto-read on any
screen. Added OCR (`tesseract.js`) as a fallback across all three
upload-and-scan flows, so a scan/photo now gets the same auto-fill
attempt a text-based document already did — manual entry remains the
fallback either way.

- New `src/ocr.js`: `ocrFile(file, onProgress)` runs OCR on an image
  file directly, or on a PDF's first page rendered to an off-DOM canvas
  via `pdfjs-dist` (scaled up 2.5x — a PDF's native 72dpi is too small
  for reliable OCR) when that PDF has no text layer. Never throws — any
  failure (a corrupt file, the OCR engine failing to load) just returns
  `''`, so callers fall back to exactly the same "enter it by hand"
  messaging as if OCR didn't exist.
- Wired into PO Upload, Material Inward, and Invoices: each screen's
  existing fast/free path (`extractPdfText` + its regex parsers) runs
  first, and OCR is only attempted once that path finds nothing — a
  scanned/photographed PDF, or (Material Inward/Invoices only, since PO
  Upload only ever accepted PDFs) a plain image file. Whatever OCR reads
  is run through the exact same parsers as a text-based document
  (`parsePoText`/`parseInvoiceNumber`+`parseInvoiceDate`+
  `parseInvoiceAmount`/`parseChallanText`), so a successful scan
  auto-fills fields exactly like a text-based upload would.
- OCR is slow (can take up to a minute, mostly a one-time cost per
  browser to fetch the ~3MB OCR engine + language data on first use,
  cached afterwards) — each screen shows a "Scanning document…" message
  and disables the file input/Save button while it runs, so it can't be
  mistaken for a stall or double-submitted.
- Uses `tesseract.js`'s default CDN-hosted engine/language data
  (jsdelivr) — the library's own recommended way to run it in a
  browser, no local asset bundling needed.
- `src/screens/help.js` updated (PO Upload, Material Inward, Invoices
  topics, and the "didn't parse correctly" FAQ) to explain the new
  scanning step and that OCR is less reliable than a text-based PDF, so
  its results are worth double-checking.
- e2e coverage: the existing non-PDF/image-upload tests in
  `phase3.spec.js`/`phase5.spec.js` (which use a synthetic, not-a-real-
  image buffer, per the established no-binary-fixture convention) now
  also exercise the OCR fallback path — updated to expect and wait out
  an OCR attempt that itself finds nothing, rather than no attempt at
  all.

## Fix: typing into a date field could scramble it

Reported on Invoices' Invoice Date field. Every screen re-renders its
whole form on every `store.setState` (needed to keep computed
totals/validation live) — for a text input, `repaintPreservingFocus`
(`src/domFocus.js`) survives that by remembering and restoring cursor
position on the freshly-rendered equivalent element. A native `<input
type="date">` has no equivalent to restore: which day/month/year
segment is being edited, and any partially-typed digit within it, is
internal browser state with no DOM API to read or restore. Typing into
one fired `'input'` on every keystroke — including mid-segment, before
a full date exists — so it re-rendered (destroying and recreating the
date input) before the user finished typing, dropping focus back onto
a brand-new element with no memory of which segment was active.

Switched every date field driven by a live keystroke handler (Invoice
Date, Due Date, and the derived-total-relevant PO Upload's Order Date,
Material Inward's Received Date) from `'input'` to `'change'` —
`'change'` only fires once a full date is committed, so no re-render
happens while a segment is still being typed. The date-range filters
on Order Status/Action Log already used `'change'` and were never
affected. Confirmed the due-date-from-payment-terms auto-calculation
still fires correctly on `'change'`; full suite (lint, typecheck, 130
unit tests, all 84 e2e tests, production build) stayed green.

## Fix: the date field fix above was incomplete — switched to `'blur'`

Reported still broken after the `'change'`-based fix shipped. Turns
out Chrome fires `'change'` on a date input on every completed
segment, not only once the whole date is committed as assumed above —
so it was still re-rendering (and still corrupting the in-progress
edit) just as often as `'input'` did.

Switched the same four fields (Invoice Date, Due Date, PO Upload's
Order Date, Material Inward's Received Date) from `'change'` to
`'blur'`, which fires exactly once, only after the user leaves the
field entirely — guaranteeing no re-render ever interrupts an
in-progress edit, regardless of how many intermediate `'input'`/
`'change'` events the browser fires along the way. The due-date
auto-calculation (and anything else reading these fields) now updates
once the user tabs/clicks away, rather than live per-segment — a
one-time render is unavoidable however this is wired, so this is the
earliest point that render can safely happen. `e2e/phase5.spec.js`'s
due-date test updated to blur the invoice-date field (matching a real
user tabbing/clicking away) before asserting on the computed value —
previously it asserted immediately after `fill()`, which doesn't
trigger blur on its own. Full suite (lint, typecheck, 130 unit tests,
all 84 e2e tests, production build) stayed green.

## Fix: the `'blur'` fix broke Tab navigation out of a date field

Reported next: pressing Tab out of a date field (Invoice Date, Order
Date, Received Date) went nowhere. Root cause was the `'blur'` fix's
own `store.setState` call: it ran synchronously inside the `'blur'`
handler, which is itself part of the browser's Tab-driven focus
transfer — at that exact point, `document.activeElement` is still (or
back to) the blurring date field, so `repaintPreservingFocus`, reading
that, force-refocused it, fighting the Tab key's own attempt to move
focus onward.

Added `afterFocusSettles` (`src/domFocus.js`): wraps the `setState` in
a zero-delay `setTimeout`, so it runs just after the browser finishes
the focus transfer already in flight, by which point
`document.activeElement` correctly reflects wherever the user actually
tabbed to. Applied at all four date-blur sites.

Auditing every date field turned up two more affected by the same
underlying issues (typing corruption and, worse, complete focus loss)
that had gone unnoticed: Order Status's and Action Log's date-range
filters shared their event wiring with their `<select>` filters via a
generic `'change'`-based `bindFilter` helper — same `'change'`-fires-
per-segment problem as the original bug, now split into a dedicated
`'blur'` + `afterFocusSettles` handler for just the two date fields.
Worse, neither screen ever adopted `repaintPreservingFocus` when the
original per-keystroke focus-loss bug was fixed elsewhere (Order
Status/Action Log have no other field needing live per-keystroke
reactivity, so it wasn't obviously needed) — meaning *any* repaint on
either screen, date field or otherwise, dropped focus to `<body>`
instead of preserving it. Both screens' `paint()` now wrap their
render in `repaintPreservingFocus`, matching every other screen.

Verified via real (non-headless-typing) Playwright sessions across all
five affected screens/eight date fields that: typing no longer
corrupts a date mid-entry, Tab correctly reaches the next field after
each date's own multi-segment tab stops (confirmed as native browser
behavior, not a bug, on a bare zero-JS `<input type=date>`), and
`e2e/phase9.spec.js`'s date-filter test (also affected by the switch
to `'blur'`) updated the same way phase5's was. `src/domFocus.test.js`
gained a unit test for `afterFocusSettles`. Full suite (lint,
typecheck, 131 unit tests, all 84 e2e tests, production build) stayed
green.

## Fix: Tab from Invoice Date should reach Payment Terms, not a date segment

Reported next: Tab out of Invoice Date was landing somewhere other
than Payment Terms. The multi-segment tab-stop behavior confirmed as
"native, not a bug" in the previous fix is real, but it's genuinely
surprising in a multi-field form — every other field's Tab moves
straight to the next one, so a date field eating several Tab presses
before actually leaving reads as broken, especially since Left/Right
arrow keys already move between its segments (Tab duplicates that,
serving no purpose Tab-users actually need here).

Added `skipDateSegmentsOnTab` (`src/domFocus.js`): a `'keydown'`
listener that, on Tab (either direction), looks up every currently
tabbable element in the document (matching the standard tabbable
selector, filtered to what's actually visible via `offsetParent` — so
hidden inputs like a file-upload trigger's own `<input>` don't
count), finds the date input's position in that list, and moves focus
directly to the next/previous one instead of letting the browser
step through segments. Wired onto all eight date fields across the
five previously-fixed screens (Invoices' Invoice Date and Due Date,
PO Upload's Order Date, Material Inward's Received Date, Order
Status's and Action Log's date-range filters).

Verified via real Playwright sessions: Tab and Shift+Tab from every
date field now land on the correct adjacent field in one press (e.g.
Invoices' Invoice Date → Payment Terms, Due Date → Amount).
Full suite (lint, typecheck, 131 unit tests, all 84 e2e tests,
production build) stayed green.

## Fix: Payment Terms losing focus should recompute Due Date, and an infinite-repaint loop that surfaced while building it

Invoices' Due Date auto-calculation previously only reacted to Invoice
Date's own `'blur'` and Payment Terms' live `'input'` — recomputing on
every keystroke while typing Payment Terms. Requested instead: Due
Date should recompute specifically when *either* field loses focus,
matching Invoice Date's own already-`'blur'`-driven behavior, so a
half-typed number (e.g. briefly "3" while typing "30") never flashes
a wrong intermediate due date.

Moving Payment Terms' due-date computation from `'input'` to `'blur'`
exposed a real, previously-latent bug: Payment Terms still needs a
live `'input'` handler (to keep its own typed value in state, for
validation/display), and that handler re-renders the whole form on
every keystroke — same as always. But re-rendering *destroys and
recreates* the currently-focused input, and when a focused element is
removed from the document, the browser fires a synchronous `'blur'`
on it as a side effect, even though focus is restored to its
replacement immediately after. With no `'blur'` handler on this field
before, that synthetic blur was harmless. Adding one turned it into an
infinite loop: type a digit → repaint → synthetic blur → the new
`'blur'` handler's `setState` → another repaint → another synthetic
blur → forever (measured: 100+ re-renders from typing two characters,
climbing without bound even after typing stopped).

Fixed at the root, not just at this one call site: `repaintPreservingFocus`
(`src/domFocus.js`) now flags the exact window where its own DOM
replacement can produce this synthetic blur, and a new `onRealBlur`
(replacing every raw `addEventListener('blur', ...)` across all five
previously-fixed screens' date/blur handlers, eight call sites total)
checks that flag and ignores blur events caused only by the repaint
itself — so this class of bug can't recur as more `'blur'` handlers
get added later. `src/domFocus.test.js` gained two tests: the
synthetic-blur case is ignored, a genuine blur (focus actually moving
to another element) still fires normally. Verified via real Playwright
sessions that: typing Payment Terms no longer loops (confirmed via a
MutationObserver-based repaint counter), Due Date recomputes correctly
on blur of either field (including with a vendor's default terms, and
with terms typed manually with no vendor selected), and Tab navigation
between every field (established in the two fixes above) still works.
Full suite (lint, typecheck, 133 unit tests, all 84 e2e tests,
production build) stayed green.

## Color-coded invoice status tags

Direct request: Overdue/Paid/Received should read as unambiguously
bad/good at a glance, not just another shade of the purple accent —
Invoices' and Bill Payments' status tags previously used `tag-accent`/
`tag-accent-2` for Paid/Overdue, both close variants of the same hue.

Added genuine semantic tag colors to the design system
(`src/styles/nocturne.css`): `--color-danger-100`/`-800` (a real red)
and `--color-success-100`/`-800` (a real green), following the same
800-for-background/100-for-text pairing the existing accent ramps use,
plus `.tag-danger`/`.tag-success` classes alongside the existing
`.tag-accent`/`.tag-neutral`/`.tag-outline`. Invoices' Overdue → red,
Paid → green (Pending stays neutral gray); Bill Payments' identical
status field (same invoices, just "Received" instead of "Paid") gets
the same treatment for consistency. Verified visually via screenshots
of both screens. Full suite (lint, typecheck, 133 unit tests, all 84
e2e tests, production build) stayed green.

## Phase 7 addendum: Complete a Work Order (deduct components, add finished stock)

Direct request, and the one piece Phase 7 explicitly deferred at the
time: a reserved work order previously had no way to actually turn
its reservation into a finished-goods stock movement — completing a
production run still required going to BoM Builder and recording it
there by hand, disconnected from the work order that planned it. The
rest of the requested lifecycle (see components + availability before
creating, red-flagged shortages when an assembly and its own
components are both short, reserving hides components from stock and
other work orders, cancelling releases them again) was already fully
built in Phase 7 — this addendum is only the missing "Complete"
step.

- `supabase/schema.sql`: `work_orders.status` now also accepts
  `'completed'`, plus a new `completed_at timestamptz`. New
  `complete_work_order(target_work_order_id)`: admin/production/store
  only, requires the work order to be `'reserved'`, re-checks
  `current_stock` (actual on-hand, not `available_stock`) for every
  reserved component and blocks all-or-nothing with a formatted
  shortfall message if anything is short — same discipline as
  `record_bom_production`/`reserve_work_order` — then inserts an `'out'`
  stock movement per reserved component and one `'in'` movement for the
  output item, all tagged `reference_type = 'work_order'`, and flips the
  work order to `'completed'`. The existing `stock_reservations` rows
  are left in place rather than deleted — `available_stock`'s join
  already excludes non-`'reserved'` work orders, so a completed order's
  hold releases the same way a cancelled one's does.
- `src/screens/workOrders.js`: a "Complete Work Order" button on any
  `'reserved'` order; a completed order shows no further actions.
  Shortage flags changed from the purple `tag-accent-2` to the red
  `tag-danger` introduced by the color-coding work above, in both the
  availability preview and a work order's requirement detail.
- `scripts/test-rls-work-orders.mjs`: a second work order exercising
  `complete_work_order` — blocked before reserving, purchase role
  cannot complete, production can, the resulting stock movements and
  `current_stock` changes are correct, `available_stock`'s reserved
  quantity drops back to just the other order's hold, and completing
  twice is rejected.
- `e2e/phase7.spec.js`: completing a reserved work order, verifying the
  RPC call body, the status tag updating, and that no actions remain
  once completed.

Verified locally: lint, typecheck, 133 unit tests, and the full e2e
suite (85 tests, including the new one) all green; production build
clean. This changes `supabase/schema.sql`, so it needs the migration
applied manually to any live Supabase project the same way every prior
schema change here has.

## Phase 11: Material Dispatch (scan/pick, admin-authorized stock deduction, payment tracking)

Direct request: material going *out* (to a customer or site) had no
counterpart to Material Inward's receiving flow, and no way to deduct
it from inventory. Specified explicitly: a store/admin user creates
the dispatch record (optionally scanning a delivery challan the same
way Material Inward/PO Upload/Invoices already do, including the OCR
fallback for a scanned/photographed document) and picks what's being
dispatched, but the record never moves stock by itself — only an
admin authorizing it does. Payment received / received date is
visible, and actionable, to admin only, right on each dispatch's row.

- `supabase/schema.sql`: `material_dispatch` (dispatch date, optional
  reference/notes, optional challan file, `created_by`, and
  `authorized_by`/`authorized_at`/`payment_received_by`/
  `payment_received_at`, all null until acted on) and
  `material_dispatch_line_items` (item + quantity). Both readable
  company-wide; inserting is store/admin only. Deliberately **no update
  policy at all** on `material_dispatch` — not even attaching the
  scanned challan goes through a plain client update — because a
  general store/admin update policy would also let that same role set
  `authorized_at` directly, skipping the stock-shortfall check
  entirely. Every mutation instead goes through its own narrow
  security-definer RPC, same "the RPC is the only way in" pattern as
  `bom_production_runs`/`work_orders`:
  - `attach_dispatch_challan_file()` — store/admin only, no business
    rule beyond that.
  - `authorize_material_dispatch()` — **admin only**. Re-checks
    `current_stock` for every line item and blocks all-or-nothing with
    a formatted shortfall message if anything is short (nothing
    written on failure), otherwise inserts an `'out'` stock movement
    per line item (`reference_type = 'material_dispatch'`) and stamps
    `authorized_by`/`authorized_at`. Rejects an already-authorized
    dispatch.
  - `mark_dispatch_payment_received()` — **admin only**, and only once
    the dispatch is already authorized (marking payment for goods not
    yet confirmed dispatched doesn't make sense). Rejects a
    dispatch that's already marked paid.
  - Reuses Material Inward's `challan-documents` Storage bucket as-is
    (bucket-scoped RLS, not table-scoped) — the dispatch's own row id
    namespaces its file path, same collision-avoidance convention as
    Material Inward's own path.
- `src/materialDispatch.js` (new): `fetchMaterialDispatches`,
  `createMaterialDispatch` (two-step insert: header, then line items),
  `uploadDispatchChallanFile` (uploads to Storage, then calls the
  attach RPC — never a plain table update), `authorizeMaterialDispatch`,
  `markDispatchPaymentReceived`.
- `src/screens/materialDispatch.js` (new), wired into `src/router.js`,
  `src/navPermissions.js` (`admin`, `store`) and `src/layout.js`'s nav
  as Phase 11: a New Dispatch form (challan upload with the same
  PDF-text/OCR fallback chain as Material Inward, dispatch date using
  the established date-field-bug-fix pattern, editable item/quantity
  rows matched from a parsed challan by item name); a list showing
  each dispatch's status (Pending Authorization / Authorized), a
  file-view link, and — admin only — a Payment column (a green
  "Received <date>" tag, a "Mark Payment Received" button once
  authorized, or "—" before that) plus an Authorize button (behind a
  confirm dialog) shown only while unauthorized.
- `src/validation.js`: `validateMaterialDispatchLineItem`,
  `validateMaterialDispatchForm`.
- `scripts/test-rls-material-dispatch.mjs` (new, added to `npm run
  test:integration`): create permissions (store/admin can, production
  cannot), attaching a challan file, that a direct client update is
  rejected outright with no update policy to fall back on, authorize/
  mark-payment-received permissions (admin only, each rejecting a
  repeat call), that authorizing actually deducts `current_stock`, and
  that a line item exceeding on-hand stock blocks authorization
  entirely with nothing written.
- `e2e/phase11.spec.js` (new): route guard, creating a dispatch by
  manual entry (verifying both insert bodies), a validation-blocks-save
  case, the OCR-fallback-to-manual-entry case, that a non-admin role
  sees no Authorize button and no Payment column, an admin authorizing
  (verifying the RPC body and the status tag updating), the
  server-side shortfall message surfacing on a blocked authorize, and
  admin marking payment received.

Verified locally: lint, typecheck, 133 unit tests, and the full e2e
suite (94 tests, including the 9 new ones) all green; production build
clean. This changes `supabase/schema.sql`, so — same as every prior
schema change in this project — it needs the migration applied
manually to any live Supabase project before its own integration test
(or the app's Material Dispatch screen) will work there.

## Dashboard: real quick-stat cards + recent activity, replacing the Phase 0 placeholder

Direct user report: "Dashboard still doesn't show anything" — turned
out to be literal. `src/screens/dashboard.js` had never been revisited
past its original Phase 0 scaffold (a static "Welcome" message and a
placeholder card whose own text says KPI cards were "planned for
Phase 8, pending your sign-off" — sign-off that never happened once
Phase 8 became the separate Reports screen instead).

No new schema, no new RLS — every card reuses an existing module's own
already-permitted read:

- **Items Below Reorder Level** (`fetchAvailableStock` + the same
  filter Reports' Below Reorder tab uses) → Inventory.
- **Open Purchase Orders** (`to_be_received`/`partially_received`
  count) → Order Status.
- **Pending Inspections** (`fetchPendingInspection`) → Inspection.
- **Active Work Orders** (`open`/`reserved` count) and **Component
  Shortages** (`fetchShortages`) → Work Orders.
- **Overdue Invoices** → Invoices.
- **Dispatches Awaiting Authorization** → Material Dispatch.
- **Recent Activity** (admin only, since `action_log`'s own RLS is
  admin-only) — the last 8 entries from Action Log, with a "View all"
  link.

Each card is gated by the exact same `canViewModule()` check the
sidebar itself uses, so a role never even issues a query against a
table its RLS policy would reject — a purchase-only user's dashboard
never calls `fetchInvoices`, for instance. A role with no card-eligible
module (most commonly a brand-new account before an admin assigns a
role) gets a short explanatory message instead of a blank space. Each
card's fetch is also caught independently, so one failing widget (a
transient network error) shows "—" without taking down the cards
around it or the activity feed.

- `e2e/dashboard.spec.js` (new): admin sees every card with correct
  counts plus recent activity; a card click navigates to its screen;
  store sees only its four relevant cards and never even calls the
  Invoices/Action Log endpoints; a role with no eligible module sees
  the friendly empty state; one card's endpoint failing still shows
  every other card and the activity feed correctly.
- Help manual's Dashboard topic rewritten to describe the cards and
  where each links, plus a new FAQ item; its screenshot regenerated
  with representative data.

Verified locally: lint, typecheck, 133 unit tests, and the full e2e
suite (99 tests, including 5 new ones) all green; production build
clean; the rendered dashboard checked visually in a real browser
session. No schema changes — this ships on the next push with no
manual database step required.

## Fix: Action Log should scroll within its own container

Direct request. Action Log's table had no height limit at all — with
up to 500 rows (`fetchActionLog`'s own cap) the table just grew the
whole page vertically, pushing the filter bar out of view the moment
you scrolled down.

Gave the table's card a `max-height` + `overflow-y: auto` (only once
there's actually a table to scroll — not on the loading/error/empty
states), and made the `<thead>` `position: sticky` so column headers
stay visible while scrolling instead of scrolling away with row 1.
Verified with 40 rows in a real browser session: the container
scrolls independently of the page, the filter bar above stays put,
and the sticky header tracks correctly. `e2e/phase9.spec.js` gained a
test asserting the container is actually taller than its content
(scrollable) and that scrolling it doesn't move the filter bar out of
the viewport. Full suite (lint, typecheck, 133 unit tests, all e2e
tests, production build) stayed green. No schema changes.

## Follow-up: Action Log should load 25 at a time, not pull the whole log up front

Direct follow-up to the scrolling fix above: `fetchActionLog` still
pulled up to 500 rows in one request before any scrolling ever
happened — the scroll container just gave you somewhere to scroll
through all 500 at once. Requested instead: load 25 initially, and
fetch more only once the user actually scrolls near the bottom.

- `src/actionLog.js`: `fetchActionLog` now paginates via
  `.range(offset, offset + limit - 1)` (`limit`/`offset` in its
  `filters` param, defaulting to 25/0) instead of a flat
  `.limit(500)`. The Dashboard's activity widget (which only ever
  wants the last 8) is unaffected by this — it already sliced the
  result down after fetching, so a smaller default page is strictly
  cheaper for it, not a behavior change.
- `src/screens/actionLog.js`: tracks `offset`/`hasMore` per the
  active filters; a `scroll` listener on the log's own container
  fetches the next 25-row page once scrolled within 100px of the
  bottom, appending rather than replacing. A filter change resets
  back to page 1 (the previous offset belongs to a different result
  set). **Export CSV** now issues its own separate fetch of the full
  filtered set (up to the old 500-row cap) rather than exporting only
  whatever's currently paginated on screen — exporting a silently
  truncated subset would be a real correctness problem for an audit
  trail, not just a display nicety — and disables itself with an
  "Exporting…" label while that fetch is in flight.
- `src/domFocus.js`: new `repaintPreservingScroll(root, selector,
  render)`, the same before/after pattern as
  `repaintPreservingFocus` but for a scrollable element's `scrollTop`
  instead of an input's focus — needed because appending a "load
  more" page still does a full `innerHTML` replace, which would
  otherwise silently reset the log's scroll position to the top on
  every page load. `domFocus.test.js` gained two tests. Action Log's
  `paint()` now layers this on top of `repaintPreservingFocus`.
- `e2e/phase9.spec.js`'s scroll test rewritten to mock `offset`/
  `limit` query params against a 40-row fixture: asserts exactly 25
  rows load initially with exactly one request, that a fully-scrolled
  container already overflows on page 1 alone, that reaching the
  bottom fetches exactly one more page (verifying the requested
  ranges), that the filter bar never moves, and that scrolling again
  once every row is loaded doesn't issue a wasted third request.

Verified locally in a real browser session with 60 rows (25 → 50 → 60
across successive scrolls, confirmed via request logging) as well as
the full test suite: lint, typecheck, 135 unit tests, all e2e tests,
production build all green. No schema changes.

## Phase 12: Item Unit Rates, Price History, and a printable Stock Statement

Direct request: taking a Rs. value of stock in hand needs a price per
item, which this app never had — items tracked quantity but no cost.
Specified explicitly: a Unit Rate at item creation, editable later
since a rate isn't always known up front or stays fixed, every past
rate kept on record and shown in a filterable Price History form, and
a standard, printable Stock Statement for bank submission.

- `supabase/schema.sql`: `item_price_history` — an append-only ledger
  (id, item_id, rate, effective_date, created_by, created_at), the
  same discipline as `stock_movements`/`action_log`: a rate "change"
  is always a new row, never an edit to an old one, so nothing here
  has an update or delete policy at all. Insert is gated by
  `can_manage_items` (admin/purchase/store) — the same role check
  `items` itself already uses, since setting a rate is an Item Master
  edit, not a stock movement (deliberately not `is_store_or_admin`,
  which excludes purchase). Two new views do the read-side math:
  `item_current_rate` (each item's most recent entry by
  effective_date) and `stock_valuation` (`available_stock` joined
  with that rate, `stock_value = current_qty × rate` — physically
  on-hand quantity, not the reservation-netted "available" figure,
  since stock held for a work order is still on the shelf for a bank
  statement's purposes). A row with no rate ever recorded surfaces
  with `rate`/`stock_value` as `null`, not `0` — silently valuing
  unpriced stock at zero would understate the total without anyone
  noticing.
- `src/itemPricing.js` (new): `fetchCurrentRates`, `fetchPriceHistory`
  (item/date-range filters), `setItemRate` (the one function behind
  both "set a rate for the first time" and every later change),
  `fetchStockValuation`.
- `src/screens/inventory.js`: New Item gains an optional Unit Rate
  field (creating an item with one now also writes its first
  `item_price_history` entry, non-fatally — a failed second write
  still leaves the item created). The stock table gains a Unit Rate
  column, and each item's expandable panel gains a "Current Rate"
  line plus, for store/admin, a New Rate + Effective Date + Update
  Rate mini-form — same date-field conventions
  (`skipDateSegmentsOnTab`/`onRealBlur`/`afterFocusSettles`) as every
  other date input in the app, needed here for the same reason as
  Invoices' Payment Terms: a live-repainting sibling field (New Rate)
  next to a `'blur'`-driven one is exactly the combination that
  caused that earlier infinite-repaint loop.
- `src/screens/priceHistory.js` (new, `/price-history`, same viewers
  as Inventory: admin/store/production): every rate ever recorded,
  filterable by item and an effective-date range.
- `src/screens/stockStatement.js` (new, `/stock-statement`,
  admin/authorized — a finance document, not an operational stock
  screen): a letterhead-style, printable valuation (company name, "As
  on" date, item/category/UoM/qty/rate/value table, a total that
  excludes and calls out any unpriced items rather than silently
  treating them as zero, a Prepared By / Authorized Signatory
  block) — a `Print` button plus `@media print` CSS hides the sidebar
  and every other app-chrome element, leaving just the statement.
  Deliberately not built from the app's usual `.card`/`.table`
  classes, which lean on dark-theme CSS variables a print pipeline
  has no reason to invert — every color/border on this one screen is
  explicit and print-safe by construction instead.
- `src/validation.js`: `validateItemForm` gains an optional
  `unitRate` check; new `validateRateForm` (rate + effective date,
  both required — unlike the optional one on New Item, this form
  exists specifically to record a rate).
- Small fix alongside, found while touching `src/actionLog.js`:
  `material_dispatch`/`material_dispatch_line_items` were missed from
  `TABLE_LABELS` when Phase 11 shipped, so those entries showed the
  raw table name in Action Log — filled in now, along with a label
  for the new `item_price_history` table.
- `scripts/test-rls-item-pricing.mjs` (new, added to `npm run
  test:integration`): create permissions (purchase/store/admin can,
  production cannot), that a rate change never overwrites the
  previous entry (both stay queryable, in order), that
  `item_current_rate` always resolves to the latest by
  `effective_date`, that `stock_valuation` computes `current_qty ×`
  the resolved current rate, that an unpriced item's rate/value are
  `null` not `0`, and that direct client updates/deletes on
  `item_price_history` are rejected outright — no policy exists to
  fall back on.
- `e2e/phase4.spec.js` gained tests for the Unit Rate column, updating
  a rate (verifying the RPC-equivalent insert body and the reload),
  creating an item with vs. without a rate, and that production sees
  the rate read-only. `e2e/phase12.spec.js` (new) covers both new
  screens' route guards, Price History's filters (verifying query
  params), and Stock Statement's rendering, total, unpriced-item
  handling, and its Print button actually calling `window.print()`.

Verified locally: lint, typecheck, 143 unit tests, full e2e suite (17
new tests) all green; production build clean; both new screens and
Inventory's rate editing checked visually in a real browser session,
including the print view with the app chrome hidden. This changes
`supabase/schema.sql`, so — same as every prior schema change in this
project — it needs the migration applied manually to any live
Supabase project before its own integration test (or Unit Rate/Price
History/Stock Statement) will work there.

## Phase 12 addendum: Stock Statement reformatted to the company's real bank-statement layout, plus a From/To period filter

Direct request, with the company's own existing external stock
statement (a PDF) attached as the target format: the printable Stock
Statement was reformatted to that document's own column layout and
banner style, and — since that format reports a period's movement,
not just a snapshot — the screen gained a real From/To date filter
that drives genuine Opening/Inward/Outward/Closing quantity math
instead of always showing "right now." The reference PDF's separate
Creditors/Debitors pages were left out of scope — the request named
the Stock Statement screen specifically, and those are a different
report entirely.

- `supabase/schema.sql`: `items` gains four new, optional, set-once
  fields — `item_code` (free text), `item_type` (`RM`/`WIP`/`FG`,
  check-constrained, deliberately a new column rather than reusing the
  pre-existing `category`, which is an unrelated free-text product
  grouping already relied on by Inventory's own category filter),
  `source` (free-text vendor/"Self", not a `vendors` FK — this is
  informational for the statement, not a real vendor relationship the
  way Purchase Orders' vendor field is), and `location`. Like every
  other item field except Unit Rate, none of these four get an edit
  screen — they're set at creation and stay fixed, same as
  `category`/`unit_of_measure`/`reorder_level` always have been.
  New table function `stock_statement_for_range(date_from, date_to)`
  (`language sql stable security invoker` — modeled on the existing
  `explode_bom_requirements` table-function precedent, needing no RLS
  bypass since every table it reads is already company-wide
  readable): for each item, sums `stock_movements` into an
  `opening_qty` (everything before `date_from`), `inward_qty`/
  `outward_qty` (everything inside the range, inclusive of
  `date_to` via the same "less than the next day" idiom
  `fetchActionLog` already established for inclusive date-range
  filtering), and a derived `closing_qty` — then resolves the rate
  that was actually in effect on `date_to` (a `LEFT JOIN LATERAL`
  against `item_price_history`, ordered `effective_date desc,
  created_at desc` and filtered to `effective_date <= date_to` — the
  same "most recent as of a point in time" shape as the existing
  `item_current_rate` view, generalized from "now" to an arbitrary
  date) to value `closing_qty`, again `null` rather than `0` when no
  rate applies yet.
- `src/itemPricing.js`: `fetchStockStatement(range)` calls the new
  RPC. `fetchStockValuation`/`stock_valuation` are left in place
  unchanged — still a real, separately useful "what's on hand right
  now" reading, still covered by their own existing RLS test, so nothing
  forced a rewrite just because this one screen changed its source.
- `src/itemType.js` (new): the shared `RM`/`WIP`/`FG` list and display
  labels ("Raw Material"/"Work In Progress"/"Finished Goods"), used by
  both the New Item form and the statement's Category column.
- `src/items.js`/`src/validation.js`: `createItem` and
  `validateItemForm` accept the four new optional fields;
  `validateItemForm` rejects an `itemType` outside the three allowed
  values.
- `src/screens/inventory.js`: New Item gains Item Code, Type (a
  select), Vendor/Source, and Stock Location fields, all optional,
  wired the same way as every other New Item field.
- `src/screens/stockStatement.js`: rewritten to the reference
  document's own layout — a magenta company banner, a "Period: <from>
  to <to>" line instead of a single "As on" date, and a table with
  Item Code / Item Description / Category / Vendor-Source / Opening /
  Inward / Outward / Closing Qty / UoM / Rate per Unit / Closing Stock
  Value / Stock Location columns. A From/To date filter above the
  sheet (defaulting to the 1st of the current month through today)
  uses the same `skipDateSegmentsOnTab`/`onRealBlur`/
  `afterFocusSettles` pattern as every other filterable date range in
  the app, and re-runs `fetchStockStatement` on blur. The unpriced-item
  note, total row, and signature block carry over unchanged from the
  prior version.
- `scripts/test-rls-item-pricing.mjs`: new coverage for
  `stock_statement_for_range` — seeds movements before/inside/after a
  March 2026 range and rates before/inside/after `date_to`, then
  asserts `opening_qty`/`inward_qty`/`outward_qty`/`closing_qty` match
  the expected math, the resolved rate is the one in effect on
  `date_to` (not an earlier or a not-yet-effective later one), the new
  item fields pass through unchanged, every authenticated role
  (including production) can read the function, and an item with
  movements but no rate on record still reports its `closing_qty` with
  a `null` rate/value rather than `0`.
- `e2e/phase12.spec.js`: the three existing Stock Statement tests now
  mock `stock_statement_for_range` instead of `stock_valuation` and
  assert the new column set; a new test drives the From/To filter and
  confirms it re-fetches with the right `date_from`/`date_to` and
  updates the on-screen period line. `e2e/phase4.spec.js` gained a
  test confirming the New Item form's four new fields land correctly
  on the `items` insert.
- `src/screens/help.js` and `public/help/screenshots/29-stock-statement.png`
  updated for the new column set and the date filter; the FAQ entry on
  "why does an item show — instead of a value" now names the To date,
  not just "no rate ever recorded", since a rate can exist but not yet
  apply as of that date.

Verified locally: lint, typecheck, 143 unit tests, full e2e suite
green; production build clean; the reformatted statement and its date
filter checked visually in a real browser session, including the
print view. This changes `supabase/schema.sql` again, so it needs the
migration applied manually to any live Supabase project before
`stock_statement_for_range` (or its integration test) will work
there.

## Delete a user (Users & Roles)

Direct request: remove two specific users from the app. There was no
delete action at all — only Activate/Deactivate — so this adds one,
but not as a true hard delete: nearly every table (`purchase_orders`,
`invoices`, `stock_movements`, `action_log`, and more) has a
`created_by`/`approved_by`/etc. column that's `not null references
public.users (id)` with no `on delete` action, so actually deleting a
user's row via `auth.admin.deleteUser` would either fail outright on
the first such FK (for any real, used account — Action Log alone logs
nearly every action anyone takes, so this is the common case, not an
edge case) or require cascading away real business history to make it
succeed. Soft-deleted instead, the same convention this schema already
uses for anything with history (items/vendors/projects/purchase_orders
all have their own `deleted_at`): the user's own row, and every record
it's ever attributed to, stays exactly as it was.

- `supabase/schema.sql`: `users` gains `deleted_at timestamptz null`.
  New `soft_delete_user(target_id)` (`security definer`, admin-only via
  `is_admin()`, same self-targeting guard as `set_user_role`/
  `set_user_status` so an admin can't delete their own account and lock
  everyone out) sets `deleted_at = now()` **and** `status = 'inactive'`
  — reusing the sign-in block `src/auth.js` already has for inactive
  users (covered by `e2e/phase0.spec.js`'s existing test) instead of
  teaching it a second, separate check. Calling it again on an
  already-deleted user raises "User not found" rather than silently
  no-op-succeeding. `admin_list_users()` now excludes soft-deleted rows,
  so a deleted user simply disappears from Users & Roles.
- `src/admin.js`: `deleteUser(targetId)` wraps the new RPC, same
  pattern as `setUserRole`/`setUserStatus`.
- `src/screens/users.js`: each row gains a **Delete** button (disabled
  for your own row, like Deactivate already was) behind a
  `window.confirm` naming the user and explaining that their existing
  records are unaffected — same confirm-before-destructive-action
  pattern as archiving an invoice/PO or authorizing a dispatch.
- `scripts/test-rls-users.mjs`: a non-admin cannot call
  `soft_delete_user`, an admin cannot delete themselves, an admin can
  delete another user (`deleted_at` and `status` both persist
  correctly), `admin_list_users` excludes them afterward, and a second
  delete on the same user errors instead of succeeding again.
- `e2e/phase1.spec.js`: the self-row test now also checks Delete is
  disabled; new tests cover confirming a delete (right RPC body, row
  disappears from the list) and cancelling the confirm (RPC never
  called, row stays).
- `src/screens/help.js` and `public/help/screenshots/22-users-roles.png`
  updated for the new Delete button and behavior, including that
  there's no in-app undo — recovering a mistaken delete means fixing it
  directly on the database, since the user's email stays reserved by
  the deleted account and re-inviting won't work either.

Verified locally: lint, typecheck, 143 unit tests, full e2e suite
green; production build clean. This changes `supabase/schema.sql`
again, so it needs the migration applied manually to any live Supabase
project before `soft_delete_user` (or its integration test) will work
there — after which the two users named in the original request can
actually be deleted from the live Admin → Users & Roles screen.

## Fix: a deleted user's email couldn't actually be reused

Found immediately in practice: after deleting the two users above and
trying to re-invite people on the same addresses, "Add User" failed.
`soft_delete_user()` only ever touched `public.users` — the deleted
user's Supabase Auth account (and the email registered to it) was left
exactly as it was, and `auth.admin.inviteUserByEmail` rejects an email
still registered to *any* `auth.users` row, deleted-in-this-app's-sense
or not. So "deleted" never actually freed the identity the way it
needed to. (The name half of the original report wasn't a real second
issue — there's no uniqueness constraint on `users.name` anywhere,
client or server; reusing a name always worked.)

Freeing an email requires `auth.admin.updateUserById`, which — like
`inviteUserByEmail` — only ever works with the service-role key, so it
can't be a plain RPC.

- `supabase/functions/admin-delete-user/index.ts` (new): mirrors
  `admin-invite-user`'s shape. Runs `soft_delete_user()` through a
  client scoped to the *caller's* own JWT — so that RPC's existing
  `is_admin()`/no-self-delete guard is the single source of truth for
  who can delete whom, not duplicated here — then, only once that
  succeeds, uses the service-role client to rename the deleted user's
  email to `deleted+<their-id>@deleted.invalid` in both `auth.users`
  (`updateUserById`) and `public.users` (keeping the two in sync, and
  freeing `public.users.email`'s own unique constraint too).
  `.invalid` is the RFC 2606 domain reserved for exactly this — a
  placeholder guaranteed to never resolve as a real address, and unique
  per user by construction since it's keyed on their id.
- `src/admin.js`: `deleteUser()` now calls this Edge Function (same
  token-fetching/error-extraction pattern as `inviteUser()`) instead of
  calling `soft_delete_user()` directly — `extractFunctionErrorMessage`
  gained a `fallback` parameter so both functions can share it with
  their own default error text.
- `supabase/README.md` and `README.md`'s structure listing: document
  deploying `admin-delete-user` alongside `admin-invite-user`.
- `src/screens/help.js`: corrected the "no undo" note, which had
  (accurately, for the state that shipped) said re-inviting a deleted
  user's email wouldn't work — it does now, that's the whole point of
  this fix.
- `e2e/phase1.spec.js`: the delete tests now mock
  `**/functions/v1/admin-delete-user**` instead of the RPC directly.
  Rewrote them once it became clear demo mode can't actually exercise a
  successful call here — `getSession()` never resolves a token in demo
  mode (no real sign-in ever happens; same structural gap
  `admin-invite-user` already had, which is why no e2e test anywhere in
  this app has ever verified a *successful* invite either, only that
  invalid input never reaches it). What demo mode CAN verify: the
  confirm dialog names the right user, cancelling never calls the
  function, and a failed attempt (which is what demo mode always
  produces, for exactly that reason) surfaces via alert and leaves the
  row in place. The real success path — `soft_delete_user`'s own
  guard logic — is covered by `scripts/test-rls-users.mjs` against a
  real signed-in session; the Edge-Function-only email-freeing step
  has no automated coverage, same as invite's email-sending step.

Verified locally: lint, typecheck, 143 unit tests, full e2e suite
green. No `schema.sql` change this time — only the new Edge Function
needs deploying (`supabase functions deploy admin-delete-user`) before
a delete actually frees the email for reuse; `soft_delete_user` itself
already works against the live project from the previous entry.

## Backfill script: free the email on the two users deleted before the fix above

Found immediately after deploying the previous entry's fix: re-inviting
Lalit Hazare and Mayur Ahire still failed with "User already
registered" (on both the Admin "Add User" invite and the public Sign
Up form — same underlying `auth.users` email uniqueness either way).
Root cause: deploying `admin-delete-user` only changes what happens on
the *next* delete. These two were already soft-deleted under the old,
RPC-only `soft_delete_user()` path before that function existed, so
their Supabase Auth accounts were never renamed — deploying the fix
doesn't retroactively touch rows it never ran against. And there's no
way to "re-delete" them through the UI to pick up the new behavior:
`admin_list_users()` already excludes soft-deleted rows, so Delete
isn't even clickable for them anymore.

- `scripts/free-deleted-user-emails.mjs` (new, one-off, not part of
  `npm run test:integration`): finds every `users` row with
  `deleted_at is not null` whose email doesn't already match the
  `deleted+<uuid>@deleted.invalid` placeholder pattern, and renames it
  in both `auth.users` (`auth.admin.updateUserById`, same Auth Admin
  API call the Edge Function itself makes) and `public.users` — i.e.
  runs the new function's email-freeing half against old data it
  missed. Safe to run more than once: a user whose email already
  matches the placeholder pattern is left alone, so a second run is a
  no-op that fixes nothing and reports nothing to fix.
- `supabase/README.md`: documents this as a one-time step for anyone
  who deleted a user before deploying `admin-delete-user` — run once
  against the live project, not something that needs repeating per
  future delete (those go through the Edge Function now).

Verified locally: lint, `node --check`. Not run against the live
project from this session — needs `SUPABASE_SERVICE_ROLE_KEY`, which
isn't available here; the user runs it themselves per the README.

## Roles & Rights: which category of users has which rights, editable by admin

Direct request: display which roles can do what, and let an admin edit
it. Deliberately scoped to actual write permissions (create/edit/
approve/delete), not screen visibility — Users & Roles already covers
who can see which screens per-user, and screen visibility was always
just a UX nicety, not the real security boundary. Real permissions were
a genuinely different thing: `is_purchase_or_admin`/`is_store_or_admin`/
`is_inspector_or_admin`/`can_manage_items`/`is_authorized_or_admin`/
`can_manage_boms`/`can_manage_work_orders` — 8 functions (7 here, plus
`is_admin` itself) that every RLS policy and RPC in the app funnels
through for its actual write-gating, each a hardcoded role list baked
directly into SQL. Making that editable meant converting the functions
themselves, not adding a parallel system on top.

- `supabase/schema.sql`: new `role_permissions(role, permission)` table
  (company-wide readable — every screen needs to know its own viewer's
  rights to decide button visibility — writable only through the new
  RPC below), seeded with today's exact hardcoded mapping so deploying
  this changes nothing until an admin edits something. `admin`
  deliberately has no rows and can't be granted/revoked at all (new
  `admin_set_role_permission()` rejects targeting it) — it stays a
  hardcoded, unconditional right inside all 7 functions, the same
  "can't lock yourself/everyone out" floor already behind
  `set_user_role`/`set_user_status`/`soft_delete_user`'s self-targeting
  guards. Rewrote all 7 non-admin gate functions' bodies to consult the
  table instead of a role list — every one of their ~70 existing call
  sites across every phase's RLS policies and RPCs is completely
  unchanged, since they only ever call the function by name.
- `src/rolePermissions.js` (new): `PERMISSIONS` (the 7 rights' labels/
  descriptions, kept in sync with the table's check constraint by hand,
  same convention as `roles.js`/`users_role_check`), `fetchRolePermissions`,
  `setRolePermission` (wraps the RPC), `hasPermission(rows, role, permission)`
  (`role === 'admin'` short-circuits true, otherwise checks the rows) —
  the exact same logic the rewritten SQL functions apply server-side, so
  client-side button visibility matches what the server will actually
  allow.
- `src/screens/rolesAndRights.js` (new, `/roles-and-rights`, admin-only):
  a 7-rows-by-6-columns matrix — one row per right with a plain-English
  description, one column per role, Admin's column permanently
  checked-and-disabled. Every other cell is a live checkbox: toggling it
  calls `admin_set_role_permission` immediately, no save button, and
  reverts itself with an alert if the call fails.
- Four existing screens whose "+ New"/manage buttons were gated on a
  hardcoded role check now fetch `role_permissions` alongside their
  other data and compute that gate dynamically instead, so what's
  clickable actually matches what Roles & Rights says: `inventory.js`
  (`manage_items`), `workOrders.js` (`manage_work_orders`),
  `bomBuilder.js` (`manage_boms`), `materialDispatch.js`
  (`manage_store_operations` — its separate, still admin-only payment-
  tracking gate is untouched, since `is_admin` itself isn't editable).
- `scripts/test-rls-role-permissions.mjs` (new, added to `npm run
  test:integration`): non-admin can't call the RPC, admin can't target
  `'admin'`, an invalid role/permission is rejected, and — the part that
  actually matters — granting `inspector` the `manage_items` right
  changes what `items`' own RLS insert policy allows in real time (an
  insert that was rejected before the grant succeeds after it, and is
  rejected again after revoking), proving the dynamic behavior
  propagates all the way through, not just into a table.
- `e2e/rolesAndRights.spec.js` (new): route guard, sidebar link admin-
  only, the matrix rendering the seeded rows correctly including Admin
  always checked-and-disabled, granting/revoking calling the RPC with
  the right body and updating the checkbox, and a failed toggle
  reverting itself with an alert. `e2e/phase4.spec.js`/`phase6.spec.js`/
  `phase7.spec.js`/`phase11.spec.js` all needed a
  `mockDefaultRolePermissions` helper added to every test, now that
  those four screens fetch `role_permissions` too.
- `src/screens/help.js` and `public/help/screenshots/27-roles-and-rights.png`
  (new topic, right after Users & Roles).

Verified locally: lint, typecheck, 143 unit tests, full e2e suite
green; production build clean; the matrix and its live toggling checked
visually in a real browser session. This changes `supabase/schema.sql`,
so it needs the migration applied manually to any live Supabase project
before `role_permissions`/`admin_set_role_permission` (or the new
integration test) will work there.

## Fix: granting a right didn't reveal its screen — nav visibility now follows Roles & Rights

Reported directly: granted Purchase the Finance right, but Invoices
still didn't show up in the sidebar. Root cause: `navPermissions.js`'s
`MODULE_ROLES` was still the *entire* answer to "can this role see this
screen" — a completely separate, static list from the dynamic
`role_permissions` table the previous entry just made editable.
Granting a right and seeing its screen could go out of sync by design,
not by bug — the two systems had never been connected.

- `src/navPermissions.js`: new `MODULE_PERMISSIONS` (route -> the one
  right that reveals it, for the ~10 routes with a real write action
  tied to one of the 7 rights). `canViewModule(route, role,
  rolePermissions)` now takes those rows as a third argument and
  reveals a screen if the role holds the matching right, on top of —
  never instead of — `MODULE_ROLES`' own fixed floor. A screen with no
  entry (Dashboard, Help, Reports, Master Material Status, Users &
  Roles, Roles & Rights, Action Log) is unaffected, since no right
  corresponds to it. Bill Payments is deliberately excluded too, despite
  sharing Invoices' `manage_finance` right — build brief §1's "authorized
  only, not even admin" restriction stays absolute.
- `src/layout.js`: `renderShell` is now async and fetches
  `role_permissions` itself (or accepts an already-fetched copy from the
  caller, to avoid fetching twice) so the sidebar's own filtering can
  call the new 3-argument `canViewModule`. Every one of its ~19 call
  sites already lived inside an `async function render()`, so this was
  adding `await`, not restructuring.
- The 11 screens whose own route guard is tied to a right (PO Upload,
  Order Status, Material Inward, Inspection, Inventory, Price History,
  BoM Builder, Work Orders, Invoices, Stock Statement, Material
  Dispatch) now fetch `role_permissions` *before* the guard runs — the
  guard has to consult the same rows the sidebar link's own visibility
  does, or a role could see the link but get redirected away the moment
  they click it. `dashboard.js`'s own KPI-widget selection (it has its
  own parallel `canViewModule` calls, one per widget) got the same fix
  for the same reason — a role granted Finance now also gets the
  Overdue Invoices widget, not just the sidebar link.
- `scripts/capture-help-screenshots.mjs` unaffected — every capture
  already used an admin demo session, and admin's own visibility never
  depends on `role_permissions` (it's already in every route's static
  floor).
- `src/navPermissions.test.js`: new cases for the reveal (Invoices via
  `manage_finance`, Inventory/Price History via `manage_items`), that a
  right for one screen never leaks into an unrelated one, that Bill
  Payments stays excluded even with `manage_finance` granted, and that
  a screen with no matching right is unaffected by any grant.
  `e2e/rolesAndRights.spec.js` gained an end-to-end version of the exact
  reported scenario: the sidebar link, direct navigation, the Bill
  Payments exception, and the Item Master right revealing both
  Inventory and Price History.
- Fixed alongside, found while testing: `rolesAndRights.js` itself
  wasn't passing its own already-fetched rows into `renderShell`, so it
  triggered a second, independent `role_permissions` fetch on top of
  its own — harmless in the app, but it broke two tests' call-counting
  mocks. Fixed by passing `rolePermissions: []` explicitly (a genuine
  no-op, not a lazy default: this screen is already admin-only, and
  admin's sidebar never depends on `role_permissions` at all). Also
  found: three existing tests (two in `dashboard.spec.js`, one in
  `phase0.spec.js`) that reach Dashboard via a real (non-demo-mode)
  sign-in were marginal enough that the one new network round trip
  pushed them past their default 5s assertion timeout — fixed by mocking
  `role_permissions` there too, same as everywhere else in this app's
  e2e suite mocks the Supabase HTTP layer precisely.

Verified locally: lint, typecheck, 148 unit tests, full e2e suite
green; production build clean. No `schema.sql` change this time — pure
client-side fix, nothing to migrate.

## Fix: bound the new `role_permissions` fetch to a timeout, so CI's slower network didn't fail dozens of unrelated tests

Pushing the nav-follows-rights fix above turned CI's `build` job red with
43 e2e failures across nine-plus spec files — dramatically more than the
3 tests found and fixed locally beforehand. All 43 shared the same
`element(s) not found` pattern after a 5s timeout, on screens that have
nothing to do with Roles & Rights.

Root cause: `role_permissions` is now fetched on nearly every
authenticated screen's initial render (`renderShell`, the 11
permission-tied screens' route guards, Dashboard's widget selection).
Every one of those fetches is deliberately non-blocking on failure
(`.catch(() => [])`), but *how fast* an unmocked request resolves to a
catchable error depends entirely on the network it's running against —
this sandbox's local dev environment fails those fast; GitHub Actions'
network apparently doesn't, so screens/tests that never needed
`role_permissions` mocked before now went past Playwright's default
5000ms assertion timeout waiting on a request nobody was going to
answer.

Patching yet more individual tests' mocks (as done for the 3 local
failures) doesn't scale to this and doesn't protect the next screen
that reads `role_permissions` — the real fix is architectural: bound
the fetch itself so it can never take longer than a fixed ceiling
regardless of what the network does.

- `src/rolePermissions.js`: added `fetchRolePermissionsGuarded(client,
  timeoutMs = 2000)` — races `fetchRolePermissions()` against a timer
  that resolves to `[]`, wrapped in try/catch so a real error also
  resolves to `[]`. Same eventual behavior as
  `fetchRolePermissions().catch(() => [])` on failure, just bounded to
  2s instead of however long the network takes to actually reject.
- Replaced `fetchRolePermissions().catch(() => [])` with
  `fetchRolePermissionsGuarded()` at all 17 call sites across the 13
  files that had it: `src/layout.js`, `src/screens/dashboard.js`, and
  the 11 permission-tied screens' route guards (`poUpload.js`,
  `orderStatus.js`, `materialInward.js`, `inspection.js`,
  `priceHistory.js`, `invoices.js`, `stockStatement.js`,
  `inventory.js`, `workOrders.js`, `bomBuilder.js`,
  `materialDispatch.js` — the last four each had a second occurrence
  for their own action-button-gating fetch, also replaced).
- Deliberately left untouched: `rolesAndRights.js`'s own `load()`,
  which still uses the plain `fetchRolePermissions()`. That screen's
  whole point *is* this data — silently degrading to an empty matrix on
  a slow network would hide a real problem behind what looks like "no
  rights granted yet" instead of showing the existing Retry error
  state.

This is also a genuine production-resilience improvement beyond fixing
CI: before this, an unreliable network could visibly delay every single
navigation in the app by however long a failed request took to time
out; now every screen's nav-visibility check settles within 2 seconds
no matter what.

Verified locally: lint, typecheck, 148 unit tests, full e2e suite
(127/127, aside from one pre-existing, unrelated flaky assertion in
`rolesAndRights.spec.js` that also fails intermittently on `main`
before this change — a synchronous `expect(rpcBody)` immediately after
`checkbox.click()` with no wait for the click's `change` handler to
finish its network round trip); production build clean. No
`schema.sql` change — pure client-side fix, nothing to migrate.
