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

-- Update policy covers both status transitions (Phase 3+) and the
-- soft-delete action (Order Status "delete" sets deleted_at, per the
-- build brief's soft-delete-on-POs scope item) — one policy, since both
-- are the same "admin/purchase can modify a PO" permission.
drop policy if exists "Purchase/admin can update purchase orders" on public.purchase_orders;
create policy "Purchase/admin can update purchase orders"
  on public.purchase_orders for update
  to authenticated
  using (public.is_purchase_or_admin(auth.uid()))
  with check (public.is_purchase_or_admin(auth.uid()));

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
