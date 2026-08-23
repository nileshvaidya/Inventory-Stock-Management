# Supabase setup

1. Create a new Supabase project.
2. Run [`schema.sql`](./schema.sql) in the SQL editor (or `supabase db push`).
3. **Authentication → Providers → Email → "Confirm email" must be disabled**
   for sign-up to work as designed: `auth.signUp()` needs to return a
   session immediately so the app can insert the new user's `public.users`
   profile row in the same flow (the insert RLS policy requires
   `auth.uid()`, which needs an active session). Re-enable it before real
   users sign up in production.
4. Copy the project URL and anon key (Project Settings → API) into a local
   `.env` (see `.env.example`) and into your Vercel project's environment
   variables. Never commit either.

## Edge Functions (Phase 1)

`supabase/functions/admin-invite-user` handles "Add User" on the Users &
Roles screen — it needs the Auth Admin API
(`auth.admin.inviteUserByEmail`), which only ever works with the
service-role key, so it can't run client-side. Deploy it once (and again
after any change to `index.ts`):

```bash
supabase link --project-ref <your-project-ref>   # one-time, if not already linked
supabase functions deploy admin-invite-user
```

`SUPABASE_URL`, `SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY` are
injected automatically for every deployed function — no manual secret
configuration needed. Until this is deployed, "Add User" will fail with a
network/404 error; everything else on the Users & Roles screen (role
assignment, activate/deactivate) runs through plain Postgres RPCs in
`schema.sql` and needs no separate deployment.

## CI integration tests

`scripts/test-rls-users.mjs` exercises the RLS policies and RPCs above
against a real project. It needs `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and
`SUPABASE_SERVICE_ROLE_KEY` — set these as **GitHub Actions repository
secrets** (Settings → Secrets and variables → Actions → New repository
secret) to enable the `integration` job in `.github/workflows/ci.yml`;
without them it logs a warning and skips rather than failing CI. Point
these at a disposable/staging project if you have one rather than
production — the script creates and deletes real auth users on every run.
Run locally with `npm run test:integration` (needs the same three values
in your local `.env`).

## Storage buckets

Not needed until Phase 2 (PO PDFs) / Phase 5 (invoice files) / Phase 10
(scanned bills). Buckets and their access policies will be documented here
as each phase adds them.
