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

## Storage buckets

Not needed until Phase 2 (PO PDFs) / Phase 5 (invoice files) / Phase 10
(scanned bills). Buckets and their access policies will be documented here
as each phase adds them.
