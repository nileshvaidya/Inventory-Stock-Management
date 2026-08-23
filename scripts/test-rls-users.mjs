// RLS/RPC integration tests for the `users` table and Phase 1's
// admin-only functions (P1-3, P1-5), run against a REAL Supabase project —
// RLS policies and security-definer RPCs can't be verified by mocking,
// only by asking the actual database. Ported from the Task_Management/
// WorkSync scaffold's test-rls-users.mjs/test-rls-admin.mjs pattern.
//
// Requires SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY (see
// .env.example). The service role is only ever used to set up and tear
// down throwaway test users; every assertion runs through an anon-key
// client signed in as one of those users, exactly like the app does.
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const ANON_KEY = process.env.SUPABASE_ANON_KEY;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !ANON_KEY || !SERVICE_ROLE_KEY) {
  console.error(
    'Missing SUPABASE_URL, SUPABASE_ANON_KEY, and/or SUPABASE_SERVICE_ROLE_KEY.\n' +
      'These integration tests need a real Supabase project — see .env.example and supabase/README.md.'
  );
  process.exit(1);
}

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const PASSWORD = 'Test-Password-' + Math.random().toString(36).slice(2);
const stamp = Date.now();

let passed = 0;
let failed = 0;
function assert(condition, message) {
  if (condition) {
    passed += 1;
    console.log('  OK:', message);
  } else {
    failed += 1;
    console.error('  FAIL:', message);
  }
}

/** @param {{ name: string, email: string, role: string|null, status?: string }} args */
async function createUser({ name, email, role, status = 'active' }) {
  const { data, error } = await admin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error) throw new Error(`createUser(${email}) failed: ${error.message}`);
  const id = data.user.id;
  const { error: insertError } = await admin.from('users').insert({ id, name, email, role, status });
  if (insertError) throw new Error(`insert users(${email}) failed: ${insertError.message}`);
  return { id, email };
}

async function signedInClient(email) {
  const client = createClient(SUPABASE_URL, ANON_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
  const { error } = await client.auth.signInWithPassword({ email, password: PASSWORD });
  if (error) throw new Error(`sign-in as ${email} failed: ${error.message}`);
  return client;
}

async function cleanup(userIds) {
  for (const id of userIds) {
    await admin.auth.admin.deleteUser(id).catch(() => {});
  }
}

async function run() {
  console.log('Setting up test users (one admin, one non-admin)...');
  const adminUser = await createUser({ name: `RLS Test Admin ${stamp}`, email: `rls-admin-${stamp}@example.com`, role: 'admin' });
  const storeUser = await createUser({ name: `RLS Test Store ${stamp}`, email: `rls-store-${stamp}@example.com`, role: 'store' });
  const userIds = [adminUser.id, storeUser.id];

  try {
    console.log("\nOwn-row RLS (Phase 0): a non-admin can see their own profile, not another user's...");
    const clientStore = await signedInClient(storeUser.email);
    const { data: ownRow } = await clientStore.from('users').select('id').eq('id', storeUser.id);
    assert((ownRow ?? []).some((r) => r.id === storeUser.id), 'store user can select their own row');
    const { data: otherRow } = await clientStore.from('users').select('id').eq('id', adminUser.id);
    assert((otherRow ?? []).length === 0, "store user's query for the admin's row returns nothing (no broad SELECT policy)");

    console.log('\nusers_role_check constraint rejects a role outside the confirmed list...');
    const { error: badRoleErr } = await admin.from('users').update({ role: 'manager' }).eq('id', storeUser.id);
    assert(!!badRoleErr, "'manager' (not in the confirmed role list) is rejected by users_role_check");

    console.log('\nadmin_list_users: admin sees everyone, a non-admin gets rejected (P1-3, P1-5)...');
    const clientAdmin = await signedInClient(adminUser.email);
    const { data: usersForAdmin, error: listErr } = await clientAdmin.rpc('admin_list_users');
    assert(!listErr, 'admin_list_users succeeds for an admin caller');
    const idsSeen = (usersForAdmin ?? []).map((u) => u.id);
    assert(idsSeen.includes(storeUser.id), "admin's admin_list_users includes the store user");

    const { data: usersForStore, error: storeListErr } = await clientStore.rpc('admin_list_users');
    assert(!storeListErr && (usersForStore ?? []).length === 0, "a non-admin's admin_list_users returns empty, no error (is_admin() check inside the RPC)");

    console.log('\nset_user_role: admin can assign a role, a non-admin cannot (P1-1, P1-3)...');
    const { error: setRoleErr } = await clientAdmin.rpc('set_user_role', { target_id: storeUser.id, new_role: 'inspector' });
    assert(!setRoleErr, "admin can change the store user's role");
    const { data: afterRoleChange } = await admin.from('users').select('role').eq('id', storeUser.id).single();
    assert(afterRoleChange.role === 'inspector', "the store user's role persisted as 'inspector'");
    await admin.from('users').update({ role: 'store' }).eq('id', storeUser.id);

    const { error: storeSetRoleErr } = await clientStore.rpc('set_user_role', { target_id: adminUser.id, new_role: 'store' });
    assert(!!storeSetRoleErr, 'a non-admin cannot call set_user_role at all');

    console.log('\nset_user_role: an admin cannot change their own role (no self-lockout)...');
    const { error: selfRoleErr } = await clientAdmin.rpc('set_user_role', { target_id: adminUser.id, new_role: 'store' });
    assert(!!selfRoleErr, "admin cannot change their own role via set_user_role");

    console.log('\nset_user_role: an invalid role value is rejected...');
    const { error: invalidRoleErr } = await clientAdmin.rpc('set_user_role', { target_id: storeUser.id, new_role: 'manager' });
    assert(!!invalidRoleErr, "set_user_role rejects a role outside the confirmed list");

    console.log('\nset_user_status: admin can deactivate/reactivate, a non-admin cannot (P1-4)...');
    const { error: setStatusErr } = await clientAdmin.rpc('set_user_status', { target_id: storeUser.id, new_status: 'inactive' });
    assert(!setStatusErr, "admin can deactivate the store user");
    const { data: afterStatusChange } = await admin.from('users').select('status').eq('id', storeUser.id).single();
    assert(afterStatusChange.status === 'inactive', "the store user's status persisted as inactive");

    // Supabase Auth itself has no concept of this app's `status` column —
    // src/auth.js's signIn() is what rejects an inactive user, by checking
    // profile.status after a successful auth-layer sign-in and signing
    // back out. That's app JS, not something a database-only integration
    // script can exercise; it's covered instead by e2e/phase0.spec.js's
    // "inactive user is blocked at sign-in" test. What this script CAN
    // verify is the data that check depends on, already covered above:
    // set_user_status actually persists 'inactive'.
    await admin.from('users').update({ status: 'active' }).eq('id', storeUser.id);

    const { error: storeSetStatusErr } = await clientStore.rpc('set_user_status', { target_id: adminUser.id, new_status: 'inactive' });
    assert(!!storeSetStatusErr, 'a non-admin cannot call set_user_status at all');

    console.log('\nset_user_status: an admin cannot deactivate themselves...');
    const { error: selfStatusErr } = await clientAdmin.rpc('set_user_status', { target_id: adminUser.id, new_status: 'inactive' });
    assert(!!selfStatusErr, 'admin cannot set their own status');
  } finally {
    console.log('\nCleaning up test users...');
    await cleanup(userIds);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

run().catch((err) => {
  console.error('Integration test run failed:', err.message);
  process.exit(1);
});
