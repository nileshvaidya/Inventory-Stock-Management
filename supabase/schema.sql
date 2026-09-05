-- Inventory & Stock Management schema — Phase 0: users + auth only.
-- Run in the Supabase SQL editor (or `supabase db push`).
-- Later phases append their own tables/policies below — keep this file the
-- running source of truth, same convention as the WorkSync/Task Management
-- scaffold this project reuses.

-- `role` is deliberately unconstrained (no CHECK) in Phase 0: the build
-- brief lists a proposed role set (Admin, Purchase, Store/Warehouse,
-- Inspector, Accounts/Authorized, Production) but says to confirm it
-- before finalizing. Phase 1 adds the CHECK constraint once the list is
-- confirmed, plus admin-driven role assignment RPCs (mirroring
-- is_active_manager/admin_list_users in the WorkSync scaffold).
--
-- The 'authorized' role name is used by src/layout.js and
-- src/screens/billPayments.js to gate the Bill Payments module — whatever
-- the final role list is called, that specific value must stay 'authorized'
-- unless the app code is updated to match.
create table if not exists public.users (
  id uuid primary key references auth.users (id) on delete cascade,
  name text not null check (char_length(trim(name)) > 0),
  email text not null unique,
  role text null,
  status text not null default 'active' check (status in ('active', 'inactive')),
  created_at timestamptz not null default now()
);

-- `create table if not exists` above is a no-op against a `users` table
-- that already exists from an earlier run — including one created with a
-- different `role` definition than intended here. Observed in practice: a
-- table created before this file's `role text null` was in place ended up
-- with `role` NOT NULL, which then broke every sign-up with "null value in
-- column role violates not-null constraint" until fixed by hand. This line
-- makes re-running this file self-healing for that specific drift — a
-- no-op if the column is already nullable, so it's safe on every run.
alter table public.users alter column role drop not null;

alter table public.users enable row level security;

-- Every user can read their own profile row.
drop policy if exists "Users can view own profile" on public.users;
create policy "Users can view own profile"
  on public.users for select
  to authenticated
  using (auth.uid() = id);

-- A newly authenticated user creates their own profile row right after
-- auth.signUp() (requires "Confirm email" disabled in Supabase Auth
-- settings so signUp() returns a session immediately — see README.md).
drop policy if exists "Users can insert own profile" on public.users;
create policy "Users can insert own profile"
  on public.users for insert
  to authenticated
  with check (auth.uid() = id);

-- Phase 1: User & Role Management. Confirmed role list — this is the only
-- place the six values are enumerated at the DB layer; src/roles.js is the
-- matching app-layer source of truth and must be kept in sync by hand.
alter table public.users drop constraint if exists users_role_check;
alter table public.users add constraint users_role_check
  check (role is null or role in ('admin', 'purchase', 'store', 'inspector', 'authorized', 'production'));

-- is_admin must be security definer: a plain subquery on public.users
-- inside a policy/RPC runs under the *calling* user's own RLS, which
-- (Phase 0) only grants visibility into their own row — so a non-admin
-- calling this would just always see "no admin row", not a real check.
-- Same rationale as WorkSync's is_active_manager().
create or replace function public.is_admin(uid uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.users
    where id = uid and role = 'admin' and status = 'active'
  );
$$;

grant execute on function public.is_admin(uuid) to authenticated;

-- Every user, for the Users & Roles table (P1-1, P1-3: admin-only — the
-- function itself enforces this, not just the calling UI).
create or replace function public.admin_list_users()
returns setof public.users
language sql
stable
security definer
set search_path = public
as $$
  select * from public.users
  where public.is_admin(auth.uid())
  order by name;
$$;

grant execute on function public.admin_list_users() to authenticated;

-- Assign/change a user's role (P1-1). Admin-only; an admin cannot change
-- their own role, so an admin can't accidentally lock themselves out —
-- same self-targeting guard as WorkSync's set_user_status/soft_delete_user.
create or replace function public.set_user_role(target_id uuid, new_role text)
returns public.users
language plpgsql
security definer
set search_path = public
as $$
declare
  updated public.users;
begin
  if not public.is_admin(auth.uid()) then
    raise exception 'Only an admin can assign roles.';
  end if;
  if target_id = auth.uid() then
    raise exception 'You cannot change your own role.';
  end if;
  if new_role is not null and new_role not in ('admin', 'purchase', 'store', 'inspector', 'authorized', 'production') then
    raise exception 'Invalid role: %', new_role;
  end if;

  update public.users set role = new_role where id = target_id
  returning * into updated;

  if updated.id is null then
    raise exception 'User not found.';
  end if;
  return updated;
end;
$$;

grant execute on function public.set_user_role(uuid, text) to authenticated;

-- Activate/deactivate a user (P1-4). Admin-only, same self-targeting
-- guard as above — mirrors WorkSync's set_user_status exactly.
create or replace function public.set_user_status(target_id uuid, new_status text)
returns public.users
language plpgsql
security definer
set search_path = public
as $$
declare
  updated public.users;
begin
  if not public.is_admin(auth.uid()) then
    raise exception 'Only an admin can change a user''s status.';
  end if;
  if target_id = auth.uid() then
    raise exception 'You cannot change your own status.';
  end if;
  if new_status not in ('active', 'inactive') then
    raise exception 'Invalid status: %', new_status;
  end if;

  update public.users set status = new_status where id = target_id
  returning * into updated;

  if updated.id is null then
    raise exception 'User not found.';
  end if;
  return updated;
end;
$$;

grant execute on function public.set_user_status(uuid, text) to authenticated;

-- Phase 2: Purchase Orders (upload, parse, Project/Order link, Order
-- Status), plus Vendor Master (build brief's "suggested additional
-- features" — confirmed in scope, feeds PO forms instead of free text).
--
-- is_purchase_or_admin mirrors is_admin's security-definer rationale: a
-- plain subquery on public.users inside a policy runs under the *calling*
-- user's own RLS, which only grants visibility into their own row.
create or replace function public.is_purchase_or_admin(uid uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.users
    where id = uid and role in ('admin', 'purchase') and status = 'active'
  );
$$;

grant execute on function public.is_purchase_or_admin(uuid) to authenticated;

create table if not exists public.vendors (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(trim(name)) > 0),
  gstin text null,
  contact text null,
  default_payment_terms_days integer null,
  created_at timestamptz not null default now(),
  deleted_at timestamptz null
);

alter table public.vendors enable row level security;

-- Company-wide read (PO/Invoice forms need to list vendors regardless of
-- the viewer's role) — write restricted to admin/purchase, same split as
-- purchase_orders below.
drop policy if exists "Authenticated users can view vendors" on public.vendors;
create policy "Authenticated users can view vendors"
  on public.vendors for select
  to authenticated
  using (true);

drop policy if exists "Purchase/admin can create vendors" on public.vendors;
create policy "Purchase/admin can create vendors"
  on public.vendors for insert
  to authenticated
  with check (public.is_purchase_or_admin(auth.uid()));

drop policy if exists "Purchase/admin can update vendors" on public.vendors;
create policy "Purchase/admin can update vendors"
  on public.vendors for update
  to authenticated
  using (public.is_purchase_or_admin(auth.uid()))
  with check (public.is_purchase_or_admin(auth.uid()));

create table if not exists public.projects (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  created_at timestamptz not null default now(),
  deleted_at timestamptz null
);

alter table public.projects enable row level security;

drop policy if exists "Authenticated users can view projects" on public.projects;
create policy "Authenticated users can view projects"
  on public.projects for select
  to authenticated
  using (true);

drop policy if exists "Purchase/admin can create projects" on public.projects;
create policy "Purchase/admin can create projects"
  on public.projects for insert
  to authenticated
  with check (public.is_purchase_or_admin(auth.uid()));

-- Full status list defined now even though Phase 2 only ever writes
-- 'to_be_received' — Phase 3 lights up the rest of the transitions, same
-- "create the full contract, light up what this phase needs" approach as
-- the Task_Management scaffold's Phase 2 tasks table.
create table if not exists public.purchase_orders (
  id uuid primary key default gen_random_uuid(),
  po_number text null,
  project_id uuid not null references public.projects (id),
  vendor_id uuid null references public.vendors (id),
  order_date date not null default current_date,
  payment_terms_days integer null,
  status text not null default 'to_be_received' check (
    status in ('to_be_received', 'partially_received', 'material_received', 'received_inspected', 'rejected')
  ),
  stated_total numeric null,
  source_pdf_name text null,
  created_by uuid not null references public.users (id),
  created_at timestamptz not null default now(),
  deleted_at timestamptz null
);

create index if not exists purchase_orders_project_id_idx on public.purchase_orders (project_id);
create index if not exists purchase_orders_order_date_idx on public.purchase_orders (order_date);

alter table public.purchase_orders enable row level security;

drop policy if exists "Authenticated users can view purchase orders" on public.purchase_orders;
create policy "Authenticated users can view purchase orders"
  on public.purchase_orders for select
  to authenticated
  using (true);

drop policy if exists "Purchase/admin can create purchase orders" on public.purchase_orders;
create policy "Purchase/admin can create purchase orders"
  on public.purchase_orders for insert
  to authenticated
  with check (public.is_purchase_or_admin(auth.uid()) and created_by = auth.uid());

-- Direct-update policy for Order Status' "Delete" (soft-delete/archive)
-- action — admin only, at the user's explicit request (previously
-- admin/purchase, same as create). Automatic status transitions
-- (Phase 3+) don't go through this policy at all: recompute_po_status
-- below is security definer specifically so a non-admin's own inspection
-- can still recompute the PO's status without needing a direct UPDATE
-- grant on purchase_orders.
drop policy if exists "Purchase/admin can update purchase orders" on public.purchase_orders;
drop policy if exists "Admin can update purchase orders" on public.purchase_orders;
create policy "Admin can update purchase orders"
  on public.purchase_orders for update
  to authenticated
  using (public.is_admin(auth.uid()))
  with check (public.is_admin(auth.uid()));

create table if not exists public.po_line_items (
  id uuid primary key default gen_random_uuid(),
  po_id uuid not null references public.purchase_orders (id) on delete cascade,
  item_name text not null check (char_length(trim(item_name)) > 0),
  quantity numeric not null check (quantity > 0),
  rate numeric not null check (rate >= 0),
  created_at timestamptz not null default now()
);

create index if not exists po_line_items_po_id_idx on public.po_line_items (po_id);

alter table public.po_line_items enable row level security;

drop policy if exists "Authenticated users can view PO line items" on public.po_line_items;
create policy "Authenticated users can view PO line items"
  on public.po_line_items for select
  to authenticated
  using (true);

drop policy if exists "Purchase/admin can create PO line items" on public.po_line_items;
create policy "Purchase/admin can create PO line items"
  on public.po_line_items for insert
  to authenticated
  with check (public.is_purchase_or_admin(auth.uid()));

-- Phase 2 addendum: per-vendor field-mapping templates for PDF/text import
-- (src/docMapping.js, src/importMappings.js) — when the built-in parsing
-- heuristics in src/pdfParser.js don't recognize a vendor's PO layout, a
-- purchase/admin user can manually map it once in the PO Upload screen and
-- have it auto-applied on future uploads from that vendor.
--
-- doc_type is free text, not a CHECK-constrained enum: future document
-- types (invoices, delivery challans, payment receipts) will reuse this
-- same table in later phases without a migration, unlike
-- purchase_orders.status above, which enumerates a fixed, already-known set.
create table if not exists public.import_field_mappings (
  id uuid primary key default gen_random_uuid(),
  doc_type text not null check (char_length(trim(doc_type)) > 0),
  vendor_id uuid not null references public.vendors (id) on delete cascade,
  template jsonb not null,
  created_by uuid not null references public.users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (doc_type, vendor_id)
);

alter table public.import_field_mappings enable row level security;

-- Company-wide read: any purchase/admin uploader benefits from a
-- teammate's earlier mapping for the same vendor, not just its author.
drop policy if exists "Authenticated users can view import field mappings" on public.import_field_mappings;
create policy "Authenticated users can view import field mappings"
  on public.import_field_mappings for select
  to authenticated
  using (true);

drop policy if exists "Purchase/admin can create import field mappings" on public.import_field_mappings;
create policy "Purchase/admin can create import field mappings"
  on public.import_field_mappings for insert
  to authenticated
  with check (public.is_purchase_or_admin(auth.uid()) and created_by = auth.uid());

-- Update policy is needed alongside insert: saveMappingForVendor() uses an
-- upsert (on the doc_type/vendor_id unique constraint) so re-mapping the
-- same vendor overwrites the existing template rather than erroring on a
-- duplicate key — Supabase's upsert issues an INSERT ... ON CONFLICT DO
-- UPDATE, which RLS evaluates against both policies depending on the path.
drop policy if exists "Purchase/admin can update import field mappings" on public.import_field_mappings;
create policy "Purchase/admin can update import field mappings"
  on public.import_field_mappings for update
  to authenticated
  using (public.is_purchase_or_admin(auth.uid()))
  with check (public.is_purchase_or_admin(auth.uid()));

-- Phase 3: Material Inward & Inspection, plus the Master Material Status
-- report. A PO can be received across multiple partial deliveries (each a
-- material_inward row); each delivery's line items are inspected once
-- (inspection_results, one row per material_inward_line_items row) into
-- accepted/rejected quantities. purchase_orders.status is no longer set
-- directly by the app for these transitions — recompute_po_status() and
-- its triggers below keep it in sync automatically from the underlying
-- receipt/inspection quantities, so it can never drift from reality
-- regardless of which screen touched the data.
--
-- Confirmed with the user: a PO's status only becomes 'rejected' if EVERY
-- unit ordered was received and inspected and NONE of it was accepted —
-- a partial rejection still shows 'received_inspected' (Master Material
-- Status is where the exact accepted/rejected/pending split per item
-- lives, not the one-word PO status).
create or replace function public.is_store_or_admin(uid uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.users
    where id = uid and role in ('admin', 'store') and status = 'active'
  );
$$;

grant execute on function public.is_store_or_admin(uuid) to authenticated;

create or replace function public.is_inspector_or_admin(uid uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.users
    where id = uid and role in ('admin', 'inspector') and status = 'active'
  );
$$;

grant execute on function public.is_inspector_or_admin(uuid) to authenticated;

create table if not exists public.material_inward (
  id uuid primary key default gen_random_uuid(),
  po_id uuid not null references public.purchase_orders (id),
  received_date date not null default current_date,
  received_by uuid not null references public.users (id),
  notes text null,
  created_at timestamptz not null default now(),
  deleted_at timestamptz null
);

create index if not exists material_inward_po_id_idx on public.material_inward (po_id);

alter table public.material_inward enable row level security;

drop policy if exists "Authenticated users can view material inward" on public.material_inward;
create policy "Authenticated users can view material inward"
  on public.material_inward for select
  to authenticated
  using (true);

drop policy if exists "Store/admin can create material inward" on public.material_inward;
create policy "Store/admin can create material inward"
  on public.material_inward for insert
  to authenticated
  with check (public.is_store_or_admin(auth.uid()) and received_by = auth.uid());

drop policy if exists "Store/admin can update material inward" on public.material_inward;
create policy "Store/admin can update material inward"
  on public.material_inward for update
  to authenticated
  using (public.is_store_or_admin(auth.uid()))
  with check (public.is_store_or_admin(auth.uid()));

create table if not exists public.material_inward_line_items (
  id uuid primary key default gen_random_uuid(),
  inward_id uuid not null references public.material_inward (id) on delete cascade,
  po_line_item_id uuid not null references public.po_line_items (id),
  received_qty numeric not null check (received_qty > 0),
  created_at timestamptz not null default now()
);

create index if not exists material_inward_line_items_inward_id_idx on public.material_inward_line_items (inward_id);
create index if not exists material_inward_line_items_po_line_item_id_idx on public.material_inward_line_items (po_line_item_id);

alter table public.material_inward_line_items enable row level security;

drop policy if exists "Authenticated users can view material inward line items" on public.material_inward_line_items;
create policy "Authenticated users can view material inward line items"
  on public.material_inward_line_items for select
  to authenticated
  using (true);

drop policy if exists "Store/admin can create material inward line items" on public.material_inward_line_items;
create policy "Store/admin can create material inward line items"
  on public.material_inward_line_items for insert
  to authenticated
  with check (public.is_store_or_admin(auth.uid()));

-- One inspection record per received line (P3: inspecting a receipt line
-- disposes all of its received_qty into accepted+rejected in one pass —
-- simpler than modeling incremental re-inspection, and matches the
-- inward/inspection split being two distinct one-time actions by two
-- different roles). rejection_reason is required whenever any quantity is
-- rejected, enforced at the DB layer, not just the form.
create table if not exists public.inspection_results (
  id uuid primary key default gen_random_uuid(),
  inward_line_item_id uuid not null unique references public.material_inward_line_items (id) on delete cascade,
  accepted_qty numeric not null default 0 check (accepted_qty >= 0),
  rejected_qty numeric not null default 0 check (rejected_qty >= 0),
  rejection_reason text null check (rejected_qty = 0 or rejection_reason is not null),
  inspected_by uuid not null references public.users (id),
  inspected_at timestamptz not null default now(),
  constraint inspection_results_disposes_something check (accepted_qty + rejected_qty > 0)
);

alter table public.inspection_results enable row level security;

drop policy if exists "Authenticated users can view inspection results" on public.inspection_results;
create policy "Authenticated users can view inspection results"
  on public.inspection_results for select
  to authenticated
  using (true);

drop policy if exists "Inspector/admin can create inspection results" on public.inspection_results;
create policy "Inspector/admin can create inspection results"
  on public.inspection_results for insert
  to authenticated
  with check (public.is_inspector_or_admin(auth.uid()) and inspected_by = auth.uid());

drop policy if exists "Inspector/admin can update inspection results" on public.inspection_results;
create policy "Inspector/admin can update inspection results"
  on public.inspection_results for update
  to authenticated
  using (public.is_inspector_or_admin(auth.uid()))
  with check (public.is_inspector_or_admin(auth.uid()));

-- Rolls up ordered/received/accepted/rejected quantities for one PO and
-- writes the resulting status. security definer: an inspector recomputing
-- status as a side effect of their own inspection needs to write
-- purchase_orders.status, which their role has no direct UPDATE grant for
-- (and shouldn't — this is the one narrow, automatic exception).
create or replace function public.recompute_po_status(target_po_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  total_ordered numeric;
  total_received numeric;
  total_accepted numeric;
  total_rejected numeric;
  new_status text;
begin
  select coalesce(sum(quantity), 0) into total_ordered
  from public.po_line_items
  where po_id = target_po_id;

  select coalesce(sum(mil.received_qty), 0) into total_received
  from public.material_inward_line_items mil
  join public.material_inward mi on mi.id = mil.inward_id
  where mi.po_id = target_po_id and mi.deleted_at is null;

  select coalesce(sum(ir.accepted_qty), 0), coalesce(sum(ir.rejected_qty), 0)
  into total_accepted, total_rejected
  from public.inspection_results ir
  join public.material_inward_line_items mil on mil.id = ir.inward_line_item_id
  join public.material_inward mi on mi.id = mil.inward_id
  where mi.po_id = target_po_id and mi.deleted_at is null;

  if total_received = 0 then
    new_status := 'to_be_received';
  elsif total_received < total_ordered then
    new_status := 'partially_received';
  elsif (total_accepted + total_rejected) < total_received then
    new_status := 'material_received';
  elsif total_accepted = 0 then
    new_status := 'rejected';
  else
    new_status := 'received_inspected';
  end if;

  update public.purchase_orders set status = new_status where id = target_po_id;
end;
$$;

create or replace function public.trg_recompute_po_status_from_inward_header()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.recompute_po_status(coalesce(new.po_id, old.po_id));
  return coalesce(new, old);
end;
$$;

drop trigger if exists recompute_po_status_after_inward_header on public.material_inward;
create trigger recompute_po_status_after_inward_header
after insert or update or delete on public.material_inward
for each row execute function public.trg_recompute_po_status_from_inward_header();

create or replace function public.trg_recompute_po_status_from_inward_line_item()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  target_po_id uuid;
begin
  select po_id into target_po_id from public.material_inward where id = coalesce(new.inward_id, old.inward_id);
  if target_po_id is not null then
    perform public.recompute_po_status(target_po_id);
  end if;
  return coalesce(new, old);
end;
$$;

drop trigger if exists recompute_po_status_after_inward_line_item on public.material_inward_line_items;
create trigger recompute_po_status_after_inward_line_item
after insert or update or delete on public.material_inward_line_items
for each row execute function public.trg_recompute_po_status_from_inward_line_item();

create or replace function public.trg_recompute_po_status_from_inspection()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  target_po_id uuid;
begin
  select mi.po_id into target_po_id
  from public.material_inward_line_items mil
  join public.material_inward mi on mi.id = mil.inward_id
  where mil.id = coalesce(new.inward_line_item_id, old.inward_line_item_id);
  if target_po_id is not null then
    perform public.recompute_po_status(target_po_id);
  end if;
  return coalesce(new, old);
end;
$$;

drop trigger if exists recompute_po_status_after_inspection on public.inspection_results;
create trigger recompute_po_status_after_inspection
after insert or update or delete on public.inspection_results
for each row execute function public.trg_recompute_po_status_from_inspection();

-- Master Material Status (P3): one row per PO line item with its running
-- Ordered/Received/Accepted/Rejected/Pending quantities — a plain view
-- (security invoker by default), so it inherits the exact same
-- company-wide read RLS already on the tables it joins, with no separate
-- policy of its own. Also reused by the Material Inward screen to show
-- "already received" per line item when logging a new delivery.
create or replace view public.master_material_status as
select
  pli.id as po_line_item_id,
  po.id as po_id,
  po.po_number,
  po.order_date,
  proj.id as project_id,
  proj.name as project_name,
  v.id as vendor_id,
  v.name as vendor_name,
  pli.item_name,
  pli.quantity as ordered_qty,
  coalesce(recv.received_qty, 0) as received_qty,
  coalesce(insp.accepted_qty, 0) as accepted_qty,
  coalesce(insp.rejected_qty, 0) as rejected_qty,
  greatest(pli.quantity - coalesce(recv.received_qty, 0), 0) as pending_qty,
  po.status as po_status
from public.po_line_items pli
join public.purchase_orders po on po.id = pli.po_id
join public.projects proj on proj.id = po.project_id
left join public.vendors v on v.id = po.vendor_id
left join (
  select mil.po_line_item_id, sum(mil.received_qty) as received_qty
  from public.material_inward_line_items mil
  join public.material_inward mi on mi.id = mil.inward_id
  where mi.deleted_at is null
  group by mil.po_line_item_id
) recv on recv.po_line_item_id = pli.id
left join (
  select mil.po_line_item_id, sum(ir.accepted_qty) as accepted_qty, sum(ir.rejected_qty) as rejected_qty
  from public.inspection_results ir
  join public.material_inward_line_items mil on mil.id = ir.inward_line_item_id
  join public.material_inward mi on mi.id = mil.inward_id
  where mi.deleted_at is null
  group by mil.po_line_item_id
) insp on insp.po_line_item_id = pli.id
where po.deleted_at is null;

grant select on public.master_material_status to authenticated;

-- Phase 4: Inventory (Item Master + a stock movement ledger). Confirmed
-- with the user before building: PO Upload gets an Item selector so new
-- line items can link to the Item Master (existing line items keep their
-- free-text item_name and simply don't feed the ledger), and accepted
-- inspections auto-create an inbound stock movement — so "current stock"
-- reflects real receiving activity without a separate manual re-entry step.
create or replace function public.can_manage_items(uid uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.users
    where id = uid and role in ('admin', 'purchase', 'store') and status = 'active'
  );
$$;

grant execute on function public.can_manage_items(uuid) to authenticated;

create table if not exists public.items (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(trim(name)) > 0),
  category text null,
  unit_of_measure text null,
  reorder_level numeric null check (reorder_level is null or reorder_level >= 0),
  created_at timestamptz not null default now(),
  deleted_at timestamptz null
);

alter table public.items enable row level security;

drop policy if exists "Authenticated users can view items" on public.items;
create policy "Authenticated users can view items"
  on public.items for select
  to authenticated
  using (true);

drop policy if exists "Purchase/store/admin can create items" on public.items;
create policy "Purchase/store/admin can create items"
  on public.items for insert
  to authenticated
  with check (public.can_manage_items(auth.uid()));

drop policy if exists "Purchase/store/admin can update items" on public.items;
create policy "Purchase/store/admin can update items"
  on public.items for update
  to authenticated
  using (public.can_manage_items(auth.uid()))
  with check (public.can_manage_items(auth.uid()));

-- Nullable, additive: existing po_line_items rows keep their free-text
-- item_name only; a new/edited row can optionally link an Item so its
-- receipts feed the stock ledger below.
alter table public.po_line_items add column if not exists item_id uuid null references public.items (id);

create table if not exists public.stock_movements (
  id uuid primary key default gen_random_uuid(),
  item_id uuid not null references public.items (id),
  movement_type text not null check (movement_type in ('in', 'out')),
  quantity numeric not null check (quantity > 0),
  reference_type text null,
  reference_id uuid null,
  notes text null,
  created_by uuid not null references public.users (id),
  created_at timestamptz not null default now()
);

create index if not exists stock_movements_item_id_idx on public.stock_movements (item_id);

alter table public.stock_movements enable row level security;

drop policy if exists "Authenticated users can view stock movements" on public.stock_movements;
create policy "Authenticated users can view stock movements"
  on public.stock_movements for select
  to authenticated
  using (true);

-- Manual entries (opening balance, adjustment) are store/admin only.
-- Auto-created "in" movements from accepted inspections (the trigger
-- below) bypass this policy entirely — that function is security definer,
-- same rationale as recompute_po_status: an inspector's own action
-- shouldn't need a direct stock_movements grant.
drop policy if exists "Store/admin can create stock movements" on public.stock_movements;
create policy "Store/admin can create stock movements"
  on public.stock_movements for insert
  to authenticated
  with check (public.is_store_or_admin(auth.uid()) and created_by = auth.uid());

-- Auto stock-in from Phase 3 inspections: fires once, on insert only (an
-- inspection_results row is a one-time disposal of a receipt line per its
-- own design — see the Phase 3 comment above), and only when the received
-- line's PO line item has an Item linked. A correction made later via
-- UPDATE on inspection_results does NOT retroactively adjust stock — a
-- known, documented limitation, not a silent gap.
create or replace function public.trg_stock_in_from_inspection()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  target_item_id uuid;
begin
  if new.accepted_qty > 0 then
    select pli.item_id into target_item_id
    from public.material_inward_line_items mil
    join public.po_line_items pli on pli.id = mil.po_line_item_id
    where mil.id = new.inward_line_item_id;

    if target_item_id is not null then
      insert into public.stock_movements (item_id, movement_type, quantity, reference_type, reference_id, created_by)
      values (target_item_id, 'in', new.accepted_qty, 'inspection', new.id, new.inspected_by);
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists stock_in_after_inspection on public.inspection_results;
create trigger stock_in_after_inspection
after insert on public.inspection_results
for each row execute function public.trg_stock_in_from_inspection();

-- Current stock per item — a plain view (security invoker), inheriting
-- the same company-wide read RLS already on items/stock_movements.
create or replace view public.current_stock as
select
  i.id as item_id,
  i.name,
  i.category,
  i.unit_of_measure,
  i.reorder_level,
  coalesce(sum(case when sm.movement_type = 'in' then sm.quantity else 0 end), 0) as qty_in,
  coalesce(sum(case when sm.movement_type = 'out' then sm.quantity else 0 end), 0) as qty_out,
  coalesce(sum(case when sm.movement_type = 'in' then sm.quantity else -sm.quantity end), 0) as current_qty
from public.items i
left join public.stock_movements sm on sm.item_id = i.id
where i.deleted_at is null
group by i.id;

grant select on public.current_stock to authenticated;

-- Phase 5: Invoices — link to one or more POs, track payment terms/due
-- dates, and overdue status. Unlike Phase 2-4's tables, this module's own
-- audience is narrow (Admin/Accounts-Authorized only, per
-- src/navPermissions.js) with no other role needing visibility, so RLS
-- here is scoped to that same pair rather than company-wide read — the
-- first module in this schema where that's the case.
create or replace function public.is_authorized_or_admin(uid uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.users
    where id = uid and role in ('admin', 'authorized') and status = 'active'
  );
$$;

grant execute on function public.is_authorized_or_admin(uuid) to authenticated;

-- paid_at (nullable timestamp) rather than a boolean: also records *when*
-- an invoice was marked paid, and "overdue" is computed as
-- `paid_at is null and due_date < today` — an invoice paid after its due
-- date correctly stops showing as overdue once paid_at is set, matching
-- real accounts-payable behavior. due_date is always a concrete stored
-- date (either typed directly or computed client-side from invoice_date +
-- payment_terms_days at save time) — no recomputation trigger needed
-- since it never needs to change after the fact.
create table if not exists public.invoices (
  id uuid primary key default gen_random_uuid(),
  invoice_number text null,
  vendor_id uuid not null references public.vendors (id),
  invoice_date date not null default current_date,
  payment_terms_days integer null,
  due_date date null,
  amount numeric not null check (amount >= 0),
  paid_at timestamptz null,
  notes text null,
  created_by uuid not null references public.users (id),
  created_at timestamptz not null default now(),
  deleted_at timestamptz null
);

create index if not exists invoices_vendor_id_idx on public.invoices (vendor_id);
create index if not exists invoices_due_date_idx on public.invoices (due_date);

alter table public.invoices enable row level security;

drop policy if exists "Authorized/admin can view invoices" on public.invoices;
create policy "Authorized/admin can view invoices"
  on public.invoices for select
  to authenticated
  using (public.is_authorized_or_admin(auth.uid()));

drop policy if exists "Authorized/admin can create invoices" on public.invoices;
create policy "Authorized/admin can create invoices"
  on public.invoices for insert
  to authenticated
  with check (public.is_authorized_or_admin(auth.uid()) and created_by = auth.uid());

-- Update policy covers both marking paid (paid_at) and the soft-delete/
-- archive action, same "one permission, two write paths" pattern as
-- purchase_orders' update policy in Phase 2.
drop policy if exists "Authorized/admin can update invoices" on public.invoices;
create policy "Authorized/admin can update invoices"
  on public.invoices for update
  to authenticated
  using (public.is_authorized_or_admin(auth.uid()))
  with check (public.is_authorized_or_admin(auth.uid()));

-- Many-to-many: one invoice can cover multiple POs (a consolidated vendor
-- invoice), and in principle a PO could later be referenced by more than
-- one invoice (a split/partial billing) — a junction table rather than a
-- single nullable FK on either side.
create table if not exists public.invoice_purchase_orders (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references public.invoices (id) on delete cascade,
  po_id uuid not null references public.purchase_orders (id),
  created_at timestamptz not null default now(),
  unique (invoice_id, po_id)
);

create index if not exists invoice_purchase_orders_invoice_id_idx on public.invoice_purchase_orders (invoice_id);
create index if not exists invoice_purchase_orders_po_id_idx on public.invoice_purchase_orders (po_id);

alter table public.invoice_purchase_orders enable row level security;

drop policy if exists "Authorized/admin can view invoice PO links" on public.invoice_purchase_orders;
create policy "Authorized/admin can view invoice PO links"
  on public.invoice_purchase_orders for select
  to authenticated
  using (public.is_authorized_or_admin(auth.uid()));

drop policy if exists "Authorized/admin can create invoice PO links" on public.invoice_purchase_orders;
create policy "Authorized/admin can create invoice PO links"
  on public.invoice_purchase_orders for insert
  to authenticated
  with check (public.is_authorized_or_admin(auth.uid()));

drop policy if exists "Authorized/admin can delete invoice PO links" on public.invoice_purchase_orders;
create policy "Authorized/admin can delete invoice PO links"
  on public.invoice_purchase_orders for delete
  to authenticated
  using (public.is_authorized_or_admin(auth.uid()));

-- Phase 6: BoM Builder (nested bills of materials + recording production).
-- Confirmed with the user before building: recording production consumes
-- only the recipe's own direct components at current stock (one level) —
-- Phase 7's Work Orders is described as the layer that explodes a
-- multi-level BoM tree to check/reserve availability further down, so
-- Phase 6 doesn't duplicate that here — and a shortfall on any component
-- blocks the whole production record rather than letting stock go
-- negative (same discipline as Phase 3 blocking over-receiving).
--
-- A BoM's own structure IS still nested (a component can itself be an item
-- with its own BoM) so Phase 7 has something to explode; a trigger below
-- blocks both direct self-reference and any deeper circular reference at
-- write time, not just at explosion time.
create or replace function public.can_manage_boms(uid uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.users
    where id = uid and role in ('admin', 'production') and status = 'active'
  );
$$;

grant execute on function public.can_manage_boms(uuid) to authenticated;

-- One active recipe per output item — edited in place (its components
-- replaced wholesale on save) rather than versioned. The partial unique
-- index (deleted_at is null) means archiving a recipe frees up its output
-- item for a fresh one.
create table if not exists public.boms (
  id uuid primary key default gen_random_uuid(),
  output_item_id uuid not null references public.items (id),
  output_qty numeric not null default 1 check (output_qty > 0),
  name text null,
  notes text null,
  created_by uuid not null references public.users (id),
  created_at timestamptz not null default now(),
  deleted_at timestamptz null
);

create unique index if not exists boms_one_active_per_output_item
  on public.boms (output_item_id)
  where deleted_at is null;

alter table public.boms enable row level security;

drop policy if exists "Authenticated users can view BoMs" on public.boms;
create policy "Authenticated users can view BoMs"
  on public.boms for select
  to authenticated
  using (true);

drop policy if exists "Admin/production can create BoMs" on public.boms;
create policy "Admin/production can create BoMs"
  on public.boms for insert
  to authenticated
  with check (public.can_manage_boms(auth.uid()) and created_by = auth.uid());

drop policy if exists "Admin/production can update BoMs" on public.boms;
create policy "Admin/production can update BoMs"
  on public.boms for update
  to authenticated
  using (public.can_manage_boms(auth.uid()))
  with check (public.can_manage_boms(auth.uid()));

create table if not exists public.bom_components (
  id uuid primary key default gen_random_uuid(),
  bom_id uuid not null references public.boms (id) on delete cascade,
  component_item_id uuid not null references public.items (id),
  quantity numeric not null check (quantity > 0),
  unique (bom_id, component_item_id)
);

create index if not exists bom_components_bom_id_idx on public.bom_components (bom_id);
create index if not exists bom_components_component_item_id_idx on public.bom_components (component_item_id);

alter table public.bom_components enable row level security;

drop policy if exists "Authenticated users can view BoM components" on public.bom_components;
create policy "Authenticated users can view BoM components"
  on public.bom_components for select
  to authenticated
  using (true);

drop policy if exists "Admin/production can create BoM components" on public.bom_components;
create policy "Admin/production can create BoM components"
  on public.bom_components for insert
  to authenticated
  with check (public.can_manage_boms(auth.uid()));

drop policy if exists "Admin/production can delete BoM components" on public.bom_components;
create policy "Admin/production can delete BoM components"
  on public.bom_components for delete
  to authenticated
  using (public.can_manage_boms(auth.uid()));

-- Cycle guard: a component can't be its own recipe's output (direct), and
-- can't already — possibly several BoMs deep — produce something that
-- includes this recipe's own output (indirect). Either would make
-- Phase 7's explosion infinite-loop.
create or replace function public.bom_cycle_would_exist(root_item_id uuid, candidate_component_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  with recursive reachable(item_id) as (
    select candidate_component_id
    union
    select bc.component_item_id
    from public.bom_components bc
    join public.boms b on b.id = bc.bom_id
    join reachable r on b.output_item_id = r.item_id
    where b.deleted_at is null
  )
  select exists (select 1 from reachable where item_id = root_item_id);
$$;

grant execute on function public.bom_cycle_would_exist(uuid, uuid) to authenticated;

create or replace function public.trg_bom_components_no_cycle()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  root_item_id uuid;
begin
  select output_item_id into root_item_id from public.boms where id = new.bom_id;
  if new.component_item_id = root_item_id then
    raise exception 'A component cannot be the same item as this recipe''s own output.';
  end if;
  if public.bom_cycle_would_exist(root_item_id, new.component_item_id) then
    raise exception 'This component would create a circular BoM reference.';
  end if;
  return new;
end;
$$;

drop trigger if exists bom_components_no_cycle on public.bom_components;
create trigger bom_components_no_cycle
before insert or update on public.bom_components
for each row execute function public.trg_bom_components_no_cycle();

-- Production runs are only ever created through record_bom_production()
-- below (security definer) — deliberately no direct insert policy on this
-- table, so a client can't bypass the stock-shortfall check by inserting
-- straight into bom_production_runs.
create table if not exists public.bom_production_runs (
  id uuid primary key default gen_random_uuid(),
  bom_id uuid not null references public.boms (id),
  output_item_id uuid not null references public.items (id),
  quantity_produced numeric not null check (quantity_produced > 0),
  notes text null,
  produced_by uuid not null references public.users (id),
  created_at timestamptz not null default now()
);

create index if not exists bom_production_runs_bom_id_idx on public.bom_production_runs (bom_id);

alter table public.bom_production_runs enable row level security;

drop policy if exists "Authenticated users can view BoM production runs" on public.bom_production_runs;
create policy "Authenticated users can view BoM production runs"
  on public.bom_production_runs for select
  to authenticated
  using (true);

-- Records production against a BoM: consumes the recipe's direct
-- components (scaled by quantity_produced / boms.output_qty) as "out"
-- stock movements and logs a matching "in" movement for the output item,
-- inside one transaction — either all of it happens or none of it does.
-- Blocks the whole thing (nothing written) if any component is short,
-- rather than letting stock go negative, same as Phase 3's over-receiving
-- guard. Known limitation, documented rather than silently accepted: two
-- concurrent production runs racing on the same shared component could
-- both pass the check before either writes (no per-item locking) — judged
-- an acceptable gap for this app's scale rather than worth the added
-- complexity of advisory locks.
create or replace function public.record_bom_production(target_bom_id uuid, qty_produced numeric, notes_in text default null)
returns public.bom_production_runs
language plpgsql
security definer
set search_path = public
as $$
declare
  bom_row public.boms%rowtype;
  multiplier numeric;
  shortfall_msg text := '';
  comp record;
  needed numeric;
  available numeric;
  run_row public.bom_production_runs%rowtype;
begin
  if not public.can_manage_boms(auth.uid()) then
    raise exception 'Not authorized to record BoM production.';
  end if;

  if qty_produced is null or qty_produced <= 0 then
    raise exception 'Quantity produced must be greater than zero.';
  end if;

  select * into bom_row from public.boms where id = target_bom_id and deleted_at is null;
  if not found then
    raise exception 'BoM not found.';
  end if;

  multiplier := qty_produced / bom_row.output_qty;

  for comp in
    select bc.component_item_id, bc.quantity, i.name
    from public.bom_components bc
    join public.items i on i.id = bc.component_item_id
    where bc.bom_id = target_bom_id
  loop
    needed := comp.quantity * multiplier;
    select coalesce(cs.current_qty, 0) into available from public.current_stock cs where cs.item_id = comp.component_item_id;
    if not found then
      available := 0;
    end if;
    if available < needed then
      shortfall_msg := shortfall_msg || format('%s (need %s, have %s); ', comp.name, needed, available);
    end if;
  end loop;

  if shortfall_msg <> '' then
    raise exception 'Insufficient stock to record production: %', shortfall_msg;
  end if;

  insert into public.bom_production_runs (bom_id, output_item_id, quantity_produced, notes, produced_by)
  values (target_bom_id, bom_row.output_item_id, qty_produced, notes_in, auth.uid())
  returning * into run_row;

  for comp in
    select bc.component_item_id, bc.quantity
    from public.bom_components bc
    where bc.bom_id = target_bom_id
  loop
    needed := comp.quantity * multiplier;
    insert into public.stock_movements (item_id, movement_type, quantity, reference_type, reference_id, created_by)
    values (comp.component_item_id, 'out', needed, 'bom_production', run_row.id, auth.uid());
  end loop;

  insert into public.stock_movements (item_id, movement_type, quantity, reference_type, reference_id, created_by)
  values (bom_row.output_item_id, 'in', qty_produced, 'bom_production', run_row.id, auth.uid());

  return run_row;
end;
$$;

grant execute on function public.record_bom_production(uuid, numeric, text) to authenticated;

-- Phase 7: Work Orders (nested BoM explosion + hard stock reservation).
-- Confirmed with the user before building, three decisions:
--  1. Explosion nets against available stock at EVERY level, not just the
--     leaves — if there's already enough of a sub-assembly on hand, its
--     own recipe never gets exploded further. Standard MRP netting.
--  2. Reservation is a hard hold: reserved units are subtracted from
--     "available" everywhere (see available_stock below), so a second
--     work order — or Phase 6's Record Production — can't also plan
--     against the same units.
--  3. This phase stops at plan + reserve. Completing/fulfilling a work
--     order (cascading actual production through it) is out of scope —
--     that still happens one recipe at a time via Phase 6's BoM Builder;
--     a work order here is a plan with stock held against it, not a
--     production run.
create or replace function public.can_manage_work_orders(uid uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.users
    where id = uid and role in ('admin', 'production', 'store') and status = 'active'
  );
$$;

grant execute on function public.can_manage_work_orders(uuid) to authenticated;

create table if not exists public.work_orders (
  id uuid primary key default gen_random_uuid(),
  output_item_id uuid not null references public.items (id),
  quantity numeric not null check (quantity > 0),
  status text not null default 'open' check (status in ('open', 'reserved', 'cancelled')),
  notes text null,
  created_by uuid not null references public.users (id),
  created_at timestamptz not null default now(),
  reserved_at timestamptz null,
  cancelled_at timestamptz null
);

create index if not exists work_orders_output_item_id_idx on public.work_orders (output_item_id);

alter table public.work_orders enable row level security;

drop policy if exists "Authenticated users can view work orders" on public.work_orders;
create policy "Authenticated users can view work orders"
  on public.work_orders for select
  to authenticated
  using (true);

-- Deliberately no insert policy: a work order (and its requirement
-- snapshot below) is only ever created through create_work_order() —
-- same "the RPC is the only way in" pattern as Phase 6's
-- bom_production_runs, since the explosion has to happen atomically with
-- the insert. The update policy only ever permits the cancel transition;
-- reserving is a separate RPC (reserve_work_order) because it also has
-- to atomically re-check availability and write stock_reservations.
drop policy if exists "Admin/production/store can cancel work orders" on public.work_orders;
create policy "Admin/production/store can cancel work orders"
  on public.work_orders for update
  to authenticated
  using (public.can_manage_work_orders(auth.uid()) and status <> 'cancelled')
  with check (public.can_manage_work_orders(auth.uid()) and status = 'cancelled');

create or replace function public.trg_work_orders_cancelled_at()
returns trigger
language plpgsql
as $$
begin
  if new.status = 'cancelled' and old.status <> 'cancelled' then
    new.cancelled_at := now();
  end if;
  return new;
end;
$$;

drop trigger if exists work_orders_cancelled_at on public.work_orders;
create trigger work_orders_cancelled_at
before update on public.work_orders
for each row execute function public.trg_work_orders_cancelled_at();

-- A snapshot of the exploded/netted requirement per item, taken once at
-- creation time — not recomputed live. reservable_qty is what was
-- available to hold at creation time (what reserve_work_order() will try
-- to actually reserve); shortfall_qty is demand the explosion couldn't
-- satisfy anywhere in the tree (no stock, and either no recipe or the
-- recipe's own inputs were also short) — informational, needs procurement
-- or production outside this work order.
create table if not exists public.work_order_requirements (
  id uuid primary key default gen_random_uuid(),
  work_order_id uuid not null references public.work_orders (id) on delete cascade,
  item_id uuid not null references public.items (id),
  reservable_qty numeric not null default 0 check (reservable_qty >= 0),
  shortfall_qty numeric not null default 0 check (shortfall_qty >= 0),
  unique (work_order_id, item_id)
);

create index if not exists work_order_requirements_work_order_id_idx on public.work_order_requirements (work_order_id);

alter table public.work_order_requirements enable row level security;

drop policy if exists "Authenticated users can view work order requirements" on public.work_order_requirements;
create policy "Authenticated users can view work order requirements"
  on public.work_order_requirements for select
  to authenticated
  using (true);
-- No insert/update/delete policy — written only by create_work_order().

create table if not exists public.stock_reservations (
  id uuid primary key default gen_random_uuid(),
  work_order_id uuid not null references public.work_orders (id) on delete cascade,
  item_id uuid not null references public.items (id),
  quantity numeric not null check (quantity > 0),
  created_at timestamptz not null default now(),
  unique (work_order_id, item_id)
);

create index if not exists stock_reservations_item_id_idx on public.stock_reservations (item_id);

alter table public.stock_reservations enable row level security;

drop policy if exists "Authenticated users can view stock reservations" on public.stock_reservations;
create policy "Authenticated users can view stock reservations"
  on public.stock_reservations for select
  to authenticated
  using (true);
-- No insert/update/delete policy — written only by reserve_work_order().

-- current_stock netted against every ACTIVE reservation (status =
-- 'reserved' work orders only — cancelling one frees its hold
-- automatically since the join drops out, without ever deleting the
-- stock_reservations audit rows). This is the "available" figure that
-- matters from here on: explode_bom_requirements nets against it, and
-- Inventory (Phase 4) now shows it alongside current_qty.
create or replace view public.available_stock as
select
  cs.item_id,
  cs.name,
  cs.category,
  cs.unit_of_measure,
  cs.reorder_level,
  cs.current_qty,
  coalesce(r.reserved_qty, 0) as reserved_qty,
  cs.current_qty - coalesce(r.reserved_qty, 0) as available_qty
from public.current_stock cs
left join (
  select sr.item_id, sum(sr.quantity) as reserved_qty
  from public.stock_reservations sr
  join public.work_orders wo on wo.id = sr.work_order_id
  where wo.status = 'reserved'
  group by sr.item_id
) r on r.item_id = cs.item_id;

grant select on public.available_stock to authenticated;

-- Recursive BoM explosion, netting demand against available_stock at
-- every level (see the phase-level comment above). Processes level by
-- level (breadth-first): every branch demanding the same item AT THE SAME
-- LEVEL is summed into one jsonb key before that level nets against
-- stock once — the case that would otherwise double-count availability.
-- Known, documented limitation: the SAME item reachable at two DIFFERENT
-- depths in a nested BoM can still have its availability netted more
-- than once across those depths (true low-level-code MRP would defer
-- every item to its single lowest occurrence before netting; this
-- doesn't). This is judged an acceptable, conservative gap for this
-- app's real recipes — critically, it can only ever make the *preview*
-- optimistic, never the actual reservation: reserve_work_order() below
-- re-checks the aggregated total against the item's one true
-- available_qty before committing anything, so an inflated preview gets
-- rejected at reserve time rather than ever over-reserving real stock.
create or replace function public.explode_bom_requirements(root_item_id uuid, root_qty numeric)
returns table (item_id uuid, item_name text, reservable_qty numeric, shortfall_qty numeric)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  current_level jsonb := jsonb_build_object(root_item_id::text, root_qty);
  next_level jsonb;
  reserve_map jsonb := '{}'::jsonb;
  shortfall_map jsonb := '{}'::jsonb;
  iterations int := 0;
  lvl_item text;
  gross numeric;
  avail numeric;
  net numeric;
  bom_row public.boms%rowtype;
  multiplier numeric;
  comp record;
begin
  if root_qty is null or root_qty <= 0 then
    raise exception 'Quantity must be greater than zero.';
  end if;
  if not exists (select 1 from public.items where id = root_item_id and deleted_at is null) then
    raise exception 'Item not found.';
  end if;

  while current_level <> '{}'::jsonb loop
    iterations := iterations + 1;
    if iterations > 50 then
      raise exception 'BoM explosion exceeded maximum depth (50) — check for an unexpectedly deep recipe tree.';
    end if;

    next_level := '{}'::jsonb;

    for lvl_item, gross in select key, value::numeric from jsonb_each_text(current_level) loop
      select coalesce(av.available_qty, 0) into avail from public.available_stock av where av.item_id = lvl_item::uuid;
      if avail is null then
        avail := 0;
      end if;

      if least(gross, avail) > 0 then
        reserve_map := jsonb_set(
          reserve_map, array[lvl_item],
          to_jsonb(coalesce((reserve_map ->> lvl_item)::numeric, 0) + least(gross, avail))
        );
      end if;

      net := greatest(gross - avail, 0);
      if net > 0 then
        select * into bom_row from public.boms where output_item_id = lvl_item::uuid and deleted_at is null;
        if found then
          multiplier := net / bom_row.output_qty;
          for comp in select component_item_id, quantity from public.bom_components where bom_id = bom_row.id loop
            next_level := jsonb_set(
              next_level, array[comp.component_item_id::text],
              to_jsonb(coalesce((next_level ->> comp.component_item_id::text)::numeric, 0) + comp.quantity * multiplier)
            );
          end loop;
        else
          shortfall_map := jsonb_set(
            shortfall_map, array[lvl_item],
            to_jsonb(coalesce((shortfall_map ->> lvl_item)::numeric, 0) + net)
          );
        end if;
      end if;
    end loop;

    current_level := next_level;
  end loop;

  return query
    select
      k::uuid,
      i.name,
      coalesce((reserve_map ->> k)::numeric, 0),
      coalesce((shortfall_map ->> k)::numeric, 0)
    from (
      select jsonb_object_keys(reserve_map) as k
      union
      select jsonb_object_keys(shortfall_map) as k
    ) keys
    join public.items i on i.id = k::uuid;
end;
$$;

grant execute on function public.explode_bom_requirements(uuid, numeric) to authenticated;

create or replace function public.create_work_order(target_output_item_id uuid, target_qty numeric, notes_in text default null)
returns public.work_orders
language plpgsql
security definer
set search_path = public
as $$
declare
  wo_row public.work_orders%rowtype;
  req record;
begin
  if not public.can_manage_work_orders(auth.uid()) then
    raise exception 'Not authorized to create work orders.';
  end if;
  if target_qty is null or target_qty <= 0 then
    raise exception 'Quantity must be greater than zero.';
  end if;

  insert into public.work_orders (output_item_id, quantity, notes, created_by)
  values (target_output_item_id, target_qty, notes_in, auth.uid())
  returning * into wo_row;

  for req in select * from public.explode_bom_requirements(target_output_item_id, target_qty) loop
    insert into public.work_order_requirements (work_order_id, item_id, reservable_qty, shortfall_qty)
    values (wo_row.id, req.item_id, req.reservable_qty, req.shortfall_qty);
  end loop;

  return wo_row;
end;
$$;

grant execute on function public.create_work_order(uuid, numeric, text) to authenticated;

-- Re-checks availability against the CURRENT available_stock (not the
-- creation-time snapshot — stock may have moved since) before committing
-- anything, and blocks (nothing written) if any item in the snapshot is
-- no longer available in full, same all-or-nothing discipline as
-- record_bom_production.
create or replace function public.reserve_work_order(target_work_order_id uuid)
returns public.work_orders
language plpgsql
security definer
set search_path = public
as $$
declare
  wo_row public.work_orders%rowtype;
  req record;
  available numeric;
  shortfall_msg text := '';
  updated_row public.work_orders%rowtype;
begin
  if not public.can_manage_work_orders(auth.uid()) then
    raise exception 'Not authorized to reserve stock for work orders.';
  end if;

  select * into wo_row from public.work_orders where id = target_work_order_id;
  if not found then
    raise exception 'Work order not found.';
  end if;
  if wo_row.status <> 'open' then
    raise exception 'Only an open work order can be reserved.';
  end if;

  for req in
    select wor.item_id, wor.reservable_qty, i.name
    from public.work_order_requirements wor
    join public.items i on i.id = wor.item_id
    where wor.work_order_id = target_work_order_id and wor.reservable_qty > 0
  loop
    select coalesce(av.available_qty, 0) into available from public.available_stock av where av.item_id = req.item_id;
    if available is null then
      available := 0;
    end if;
    if available < req.reservable_qty then
      shortfall_msg := shortfall_msg || format('%s (need %s, have %s available); ', req.name, req.reservable_qty, available);
    end if;
  end loop;

  if shortfall_msg <> '' then
    raise exception 'Cannot reserve — stock has changed since this work order was created: %', shortfall_msg;
  end if;

  insert into public.stock_reservations (work_order_id, item_id, quantity)
  select work_order_id, item_id, reservable_qty
  from public.work_order_requirements
  where work_order_id = target_work_order_id and reservable_qty > 0;

  update public.work_orders set status = 'reserved', reserved_at = now() where id = target_work_order_id
  returning * into updated_row;

  return updated_row;
end;
$$;

grant execute on function public.reserve_work_order(uuid) to authenticated;

-- Phase 9: Action Log. Confirmed with the user before building: capture
-- writes automatically via a single reusable trigger attached to every
-- mutable table, rather than adding an explicit "log this" call to each
-- write path across ~15 existing files — a trigger can't be forgotten by
-- a future write path the way an app-layer call could, and it also
-- correctly captures writes made through a security-definer RPC (e.g.
-- record_bom_production, create_work_order), since auth.uid() reflects
-- the original calling user's JWT throughout, not the function owner's
-- elevated privileges.
create table if not exists public.action_log (
  id uuid primary key default gen_random_uuid(),
  table_name text not null,
  operation text not null check (operation in ('INSERT', 'UPDATE', 'DELETE')),
  row_id uuid null,
  -- on delete set null: an audit trail shouldn't block deleting the user
  -- it references, and shouldn't disappear with them either — the log
  -- entry (what happened, to what, when) still stands on its own once
  -- attribution is nulled out.
  user_id uuid null references public.users (id) on delete set null,
  old_data jsonb null,
  new_data jsonb null,
  created_at timestamptz not null default now()
);

create index if not exists action_log_created_at_idx on public.action_log (created_at desc);
create index if not exists action_log_user_id_idx on public.action_log (user_id);
create index if not exists action_log_table_name_idx on public.action_log (table_name);

alter table public.action_log enable row level security;

drop policy if exists "Admin can view the action log" on public.action_log;
create policy "Admin can view the action log"
  on public.action_log for select
  to authenticated
  using (public.is_admin(auth.uid()));
-- Deliberately no insert/update/delete policy for direct clients — only
-- ever written by trg_log_action() below, a security-definer trigger.

-- Skips logging when there's no authenticated user (auth.uid() is null)
-- — service-role writes (migrations, the RLS integration test scripts'
-- admin client, Supabase Auth's own user-creation step) are
-- infrastructure noise, not an app user's action.
create or replace function public.trg_log_action()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  acting_user uuid := auth.uid();
  target_row_id uuid;
begin
  if acting_user is null then
    if tg_op = 'DELETE' then
      return old;
    end if;
    return new;
  end if;

  if tg_op = 'DELETE' then
    target_row_id := old.id;
  else
    target_row_id := new.id;
  end if;

  insert into public.action_log (table_name, operation, row_id, user_id, old_data, new_data)
  values (
    tg_table_name,
    tg_op,
    target_row_id,
    acting_user,
    case when tg_op in ('UPDATE', 'DELETE') then to_jsonb(old) else null end,
    case when tg_op in ('INSERT', 'UPDATE') then to_jsonb(new) else null end
  );

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

-- Attached to every table with real mutations across every phase so far
-- (action_log itself excluded — no self-logging). Adding a table here is
-- the only step a future phase needs for its writes to show up in the
-- log; every table in this schema uses `id` as its primary key, which
-- to_jsonb(old/new).id relies on implicitly via old.id/new.id below.
do $$
declare
  t text;
begin
  foreach t in array array[
    'users', 'vendors', 'projects', 'purchase_orders', 'po_line_items', 'import_field_mappings',
    'material_inward', 'material_inward_line_items', 'inspection_results',
    'items', 'stock_movements',
    'invoices', 'invoice_purchase_orders',
    'boms', 'bom_components', 'bom_production_runs',
    'work_orders', 'work_order_requirements', 'stock_reservations'
  ]
  loop
    execute format('drop trigger if exists log_action on public.%I', t);
    execute format('create trigger log_action after insert or update or delete on public.%I for each row execute function public.trg_log_action()', t);
  end loop;
end $$;

-- Phase 10: Bill Payments. Confirmed with the user before building: "Bill"
-- and "Invoice" are the same record, not a separate entity — Phase 5
-- already gives Invoices a complete paid/overdue lifecycle, so this phase
-- doesn't add a bill_payments table (nothing to log via trg_log_action
-- beyond what Phase 5's invoices trigger already captures). The one real
-- capability this phase adds is the scanned bill document itself: a
-- private Storage bucket plus two nullable columns on invoices recording
-- where the file lives. The /bill-payments screen (src/navPermissions.js:
-- authorized role only, no admin — a narrower audience than Invoices'
-- own admin/authorized RLS) is a purpose-built, upload-and-mark-received
-- workflow over this same invoices data; invoice creation itself stays on
-- the existing Invoices screen.
alter table public.invoices add column if not exists bill_file_path text null;
alter table public.invoices add column if not exists bill_file_name text null;

insert into storage.buckets (id, name, public)
values ('bill-documents', 'bill-documents', false)
on conflict (id) do nothing;

-- storage.objects already has RLS enabled by Supabase itself; only the
-- policies need adding here. Scoped to the same is_authorized_or_admin()
-- pair as invoices' own RLS (not the narrower authorized-only nav gate,
-- which is a UI-layer restriction on top of this, same relationship as
-- every other module's nav matrix vs. its table RLS).
drop policy if exists "Authorized/admin can view bill documents" on storage.objects;
create policy "Authorized/admin can view bill documents"
  on storage.objects for select
  to authenticated
  using (bucket_id = 'bill-documents' and public.is_authorized_or_admin(auth.uid()));

drop policy if exists "Authorized/admin can upload bill documents" on storage.objects;
create policy "Authorized/admin can upload bill documents"
  on storage.objects for insert
  to authenticated
  with check (bucket_id = 'bill-documents' and public.is_authorized_or_admin(auth.uid()));

drop policy if exists "Authorized/admin can delete bill documents" on storage.objects;
create policy "Authorized/admin can delete bill documents"
  on storage.objects for delete
  to authenticated
  using (bucket_id = 'bill-documents' and public.is_authorized_or_admin(auth.uid()));

-- Material Inward's scanned delivery challan (direct user request, mirrors
-- Invoices' scanned bill document above): a private Storage bucket plus
-- two nullable columns on material_inward recording where the file lives.
-- One challan document per logged receipt header (material_inward), not
-- per line item — a single delivery note covers everything received in
-- that one delivery.
alter table public.material_inward add column if not exists challan_file_path text null;
alter table public.material_inward add column if not exists challan_file_name text null;

insert into storage.buckets (id, name, public)
values ('challan-documents', 'challan-documents', false)
on conflict (id) do nothing;

-- View matches material_inward's own SELECT policy (company-wide read —
-- Order Status/Master Material Status/Inspection all read this table
-- regardless of role, so whoever can see the receipt can see its
-- challan too); only insert/delete are scoped to is_store_or_admin(),
-- matching the table's own write policy.
drop policy if exists "Authenticated users can view challan documents" on storage.objects;
create policy "Authenticated users can view challan documents"
  on storage.objects for select
  to authenticated
  using (bucket_id = 'challan-documents');

drop policy if exists "Store/admin can upload challan documents" on storage.objects;
create policy "Store/admin can upload challan documents"
  on storage.objects for insert
  to authenticated
  with check (bucket_id = 'challan-documents' and public.is_store_or_admin(auth.uid()));

drop policy if exists "Store/admin can delete challan documents" on storage.objects;
create policy "Store/admin can delete challan documents"
  on storage.objects for delete
  to authenticated
  using (bucket_id = 'challan-documents' and public.is_store_or_admin(auth.uid()));
