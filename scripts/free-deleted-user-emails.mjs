// One-off backfill: frees the email address on every user who was
// soft-deleted BEFORE admin-delete-user (the Edge Function that renames a
// deleted user's email to a deleted+<id>@deleted.invalid placeholder — see
// supabase/functions/admin-delete-user/index.ts) existed. Deploying that
// function only changes what happens on the NEXT delete; anyone already
// soft-deleted under the old soft_delete_user()-only path still has their
// real email sitting on their (deleted) Supabase Auth account, which is
// exactly why re-inviting or re-signing-up on that address still fails
// with "User already registered" even after the function is deployed.
//
// Safe to run more than once: only touches rows whose email doesn't
// already look like a deleted+<uuid>@deleted.invalid placeholder, so a
// second run is a no-op. Needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY
// (see .env.example) — the same Auth Admin API the Edge Function itself
// uses, just run from a trusted local/CI context instead of Deno.
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  console.error(
    'Missing SUPABASE_URL and/or SUPABASE_SERVICE_ROLE_KEY.\n' + 'This script needs a real Supabase project — see .env.example and supabase/README.md.'
  );
  process.exit(1);
}

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const PLACEHOLDER_PATTERN = /^deleted\+[0-9a-f-]+@deleted\.invalid$/i;

async function run() {
  const { data: deletedUsers, error } = await admin.from('users').select('id, name, email, deleted_at').not('deleted_at', 'is', null);
  if (error) {
    console.error('Could not list soft-deleted users:', error.message);
    process.exit(1);
  }

  const stale = (deletedUsers ?? []).filter((u) => !PLACEHOLDER_PATTERN.test(u.email));
  if (stale.length === 0) {
    console.log('Nothing to do — every soft-deleted user already has a freed placeholder email.');
    return;
  }

  console.log(`Found ${stale.length} soft-deleted user(s) still holding their real email address:`);
  for (const u of stale) console.log(`  - ${u.name} <${u.email}> (deleted ${u.deleted_at})`);
  console.log('');

  let fixed = 0;
  let failed = 0;
  for (const u of stale) {
    const placeholderEmail = `deleted+${u.id}@deleted.invalid`;
    const { error: authErr } = await admin.auth.admin.updateUserById(u.id, { email: placeholderEmail });
    if (authErr) {
      console.error(`  FAILED (auth): ${u.name} <${u.email}> — ${authErr.message}`);
      failed += 1;
      continue;
    }
    const { error: profileErr } = await admin.from('users').update({ email: placeholderEmail }).eq('id', u.id);
    if (profileErr) {
      console.error(`  FAILED (profile row, auth already updated!): ${u.name} — ${profileErr.message}`);
      failed += 1;
      continue;
    }
    console.log(`  OK: ${u.name} — freed "${u.email}", now "${placeholderEmail}"`);
    fixed += 1;
  }

  console.log(`\n${fixed} fixed, ${failed} failed.`);
  if (failed > 0) process.exit(1);
}

run().catch((err) => {
  console.error('Backfill run failed:', err.message);
  process.exit(1);
});
