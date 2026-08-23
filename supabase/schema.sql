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
