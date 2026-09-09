// RLS/RPC integration tests for the Roles & Rights addendum's
// role_permissions table and admin_set_role_permission() RPC, run
// against a REAL Supabase project — same pattern as test-rls-users.mjs.
// The real point of this feature is that granting/revoking a permission
// actually changes what a role's gate function (is_purchase_or_admin,
// can_manage_items, etc.) allows, not just that a row appears in a
// table — so this exercises that end-to-end via items' own RLS insert
// policy (can_manage_items), not just role_permissions in isolation.
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

/** @param {{ name: string, email: string, role: string }} args */
async function createUser({ name, email, role }) {
  const { data, error } = await admin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error) throw new Error(`createUser(${email}) failed: ${error.message}`);
  const id = data.user.id;
  const { error: insertError } = await admin.from('users').insert({ id, name, email, role, status: 'active' });
  if (insertError) throw new Error(`insert users(${email}) failed: ${insertError.message}`);
  return { id, email };
}

async function signedInClient(email) {
  const client = createClient(SUPABASE_URL, ANON_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
  const { error } = await client.auth.signInWithPassword({ email, password: PASSWORD });
  if (error) throw new Error(`sign-in as ${email} failed: ${error.message}`);
  return client;
}

async function cleanup({ userIds, itemIds }) {
  for (const itemId of itemIds) {
    await admin.from('items').delete().eq('id', itemId);
  }
  // Revoke whatever this run granted, whether or not the run's later
  // assertions ran — a failed assertion partway through must not leave
  // the live project with a permission this script itself granted.
  await admin.from('role_permissions').delete().eq('role', 'inspector').eq('permission', 'manage_items');
  for (const id of userIds) {
    await admin.auth.admin.deleteUser(id).catch(() => {});
  }
}

async function run() {
  console.log('Setting up test users (admin, inspector)...');
  const adminUser = await createUser({ name: `RLS Test Admin Perms ${stamp}`, email: `rls-admin-perms-${stamp}@example.com`, role: 'admin' });
  const inspectorUser = await createUser({
    name: `RLS Test Inspector Perms ${stamp}`,
    email: `rls-inspector-perms-${stamp}@example.com`,
    role: 'inspector',
  });
  const userIds = [adminUser.id, inspectorUser.id];
  const itemIds = [];

  try {
    const clientAdmin = await signedInClient(adminUser.email);
    const clientInspector = await signedInClient(inspectorUser.email);

    console.log('\nrole_permissions: company-wide readable, including by a non-admin (client needs this to decide its own button visibility)...');
    const { data: seedRows, error: seedErr } = await clientInspector.from('role_permissions').select('*');
    assert(!seedErr, `inspector can read role_permissions${seedErr ? ` (${seedErr.message})` : ''}`);
    assert(
      (seedRows ?? []).some((r) => r.role === 'purchase' && r.permission === 'manage_purchasing'),
      'the seeded default (purchase -> manage_purchasing) is present'
    );
    assert(
      !(seedRows ?? []).some((r) => r.role === 'admin'),
      "'admin' never appears as a row — it's a hardcoded, unconditional right, not stored here"
    );

    console.log("\ncan_manage_items (via items' own insert policy): inspector cannot create an item by default...");
    const { error: beforeGrantErr } = await clientInspector.from('items').insert({ name: `RLS Test Widget Perms ${stamp}` }).select().single();
    assert(!!beforeGrantErr, "inspector's insert into items is rejected before manage_items is granted");

    console.log('\nadmin_set_role_permission: a non-admin cannot call it...');
    const { error: nonAdminErr } = await clientInspector.rpc('admin_set_role_permission', {
      target_role: 'inspector',
      target_permission: 'manage_items',
      granted: true,
    });
    assert(!!nonAdminErr, 'inspector cannot grant itself (or anyone) a permission');

    console.log("\nadmin_set_role_permission: admin cannot target 'admin' itself...");
    const { error: targetAdminErr } = await clientAdmin.rpc('admin_set_role_permission', {
      target_role: 'admin',
      target_permission: 'manage_items',
      granted: true,
    });
    assert(!!targetAdminErr, "admin_set_role_permission rejects target_role = 'admin'");

    console.log('\nadmin_set_role_permission: an invalid role/permission is rejected...');
    const { error: badRoleErr } = await clientAdmin.rpc('admin_set_role_permission', {
      target_role: 'manager',
      target_permission: 'manage_items',
      granted: true,
    });
    assert(!!badRoleErr, "an invalid role ('manager') is rejected");
    const { error: badPermErr } = await clientAdmin.rpc('admin_set_role_permission', {
      target_role: 'inspector',
      target_permission: 'delete_everything',
      granted: true,
    });
    assert(!!badPermErr, "an invalid permission ('delete_everything') is rejected");

    console.log('\nadmin_set_role_permission: admin grants inspector manage_items — the row appears, and the underlying RLS policy actually changes...');
    const { error: grantErr } = await clientAdmin.rpc('admin_set_role_permission', {
      target_role: 'inspector',
      target_permission: 'manage_items',
      granted: true,
    });
    assert(!grantErr, `admin can grant inspector manage_items${grantErr ? ` (${grantErr.message})` : ''}`);
    const { data: afterGrantRows } = await admin.from('role_permissions').select('*').eq('role', 'inspector').eq('permission', 'manage_items');
    assert((afterGrantRows ?? []).length === 1, 'the granted row now exists in role_permissions');

    const { data: newItem, error: afterGrantErr } = await clientInspector
      .from('items')
      .insert({ name: `RLS Test Widget Perms ${stamp}` })
      .select()
      .single();
    assert(!afterGrantErr, `inspector can now create an item, purely because the permission was granted${afterGrantErr ? ` (${afterGrantErr.message})` : ''}`);
    if (newItem) itemIds.push(newItem.id);

    console.log('\nadmin_set_role_permission: revoking removes the row and the RLS policy reverts...');
    const { error: revokeErr } = await clientAdmin.rpc('admin_set_role_permission', {
      target_role: 'inspector',
      target_permission: 'manage_items',
      granted: false,
    });
    assert(!revokeErr, `admin can revoke inspector's manage_items${revokeErr ? ` (${revokeErr.message})` : ''}`);
    const { data: afterRevokeRows } = await admin.from('role_permissions').select('*').eq('role', 'inspector').eq('permission', 'manage_items');
    assert((afterRevokeRows ?? []).length === 0, 'the row is gone from role_permissions after revoking');

    const { error: afterRevokeErr } = await clientInspector.from('items').insert({ name: `RLS Test Widget Perms 2 ${stamp}` }).select().single();
    assert(!!afterRevokeErr, "inspector's insert into items is rejected again after the permission is revoked");
  } finally {
    console.log('\nCleaning up test data...');
    await cleanup({ userIds, itemIds });
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

run().catch((err) => {
  console.error('Integration test run failed:', err.message);
  process.exit(1);
});
