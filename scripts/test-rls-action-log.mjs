// RLS/RPC integration tests for Phase 9's action_log table and the
// trg_log_action() trigger attached to every mutable table (see
// supabase/schema.sql), run against a REAL Supabase project — same
// pattern and rationale as test-rls-boms.mjs.
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

async function cleanup({ userIds, workOrderIds, itemIds }) {
  await admin.from('action_log').delete().eq('table_name', 'items').in('row_id', itemIds);
  await admin.from('action_log').delete().eq('table_name', 'work_orders').in('row_id', workOrderIds);
  for (const woId of workOrderIds) {
    await admin.from('work_order_requirements').delete().eq('work_order_id', woId);
    await admin.from('work_orders').delete().eq('id', woId);
  }
  for (const itemId of itemIds) {
    await admin.from('items').delete().eq('id', itemId);
  }
  for (const id of userIds) {
    await admin.auth.admin.deleteUser(id).catch(() => {});
  }
}

async function run() {
  console.log('Setting up test users (store, admin)...');
  const storeUser = await createUser({ name: `RLS Test Store Log ${stamp}`, email: `rls-store-log-${stamp}@example.com`, role: 'store' });
  const adminUser = await createUser({ name: `RLS Test Admin Log ${stamp}`, email: `rls-admin-log-${stamp}@example.com`, role: 'admin' });
  const userIds = [storeUser.id, adminUser.id];

  const itemIds = [];
  const workOrderIds = [];

  try {
    const clientStore = await signedInClient(storeUser.email);
    const clientAdmin = await signedInClient(adminUser.email);

    console.log('\nA plain authenticated INSERT is logged, attributed to the acting user...');
    const { data: item, error: itemErr } = await clientStore
      .from('items')
      .insert({ name: `RLS Test Item Log ${stamp}`, reorder_level: 10 })
      .select()
      .single();
    assert(!itemErr, `store role can create an item${itemErr ? ` (${itemErr.message})` : ''}`);
    if (item) itemIds.push(item.id);

    // Everything below needs the item created above — if that insert
    // failed (e.g. this Supabase project hasn't had the Phase 9
    // migration applied yet), skip it as an explicit failure instead of
    // dereferencing null data and crashing before cleanup runs. Same for
    // action_log itself — probe it once up front so a missing-table gap
    // (schema not applied yet) produces one clear failure message instead
    // of a dozen confusing ones further down.
    const { error: actionLogProbeErr } = await admin.from('action_log').select('id').limit(1);
    if (item && !actionLogProbeErr) {
      const { data: insertLog, error: insertLogErr } = await admin
        .from('action_log')
        .select('*')
        .eq('table_name', 'items')
        .eq('operation', 'INSERT')
        .eq('row_id', item.id)
        .maybeSingle();
      assert(!!insertLog, `an action_log row exists for the item INSERT${insertLogErr ? ` (${insertLogErr.message})` : ''}`);
      assert(insertLog?.user_id === storeUser.id, "the log row's user_id is the store user who created it");
      assert(insertLog?.new_data?.name === `RLS Test Item Log ${stamp}`, "new_data captures the inserted row's data");
      assert(insertLog?.old_data === null, 'old_data is null for an INSERT');

      console.log('\nA plain authenticated UPDATE is logged with both old and new data...');
      const { error: updateErr } = await clientStore.from('items').update({ reorder_level: 25 }).eq('id', item.id);
      assert(!updateErr, `store role can update the item${updateErr ? ` (${updateErr.message})` : ''}`);
      const { data: updateLog, error: updateLogErr } = await admin
        .from('action_log')
        .select('*')
        .eq('table_name', 'items')
        .eq('operation', 'UPDATE')
        .eq('row_id', item.id)
        .maybeSingle();
      assert(!!updateLog, `an action_log row exists for the item UPDATE${updateLogErr ? ` (${updateLogErr.message})` : ''}`);
      assert(Number(updateLog?.old_data?.reorder_level) === 10, "old_data captures the item's prior reorder_level (10)");
      assert(Number(updateLog?.new_data?.reorder_level) === 25, "new_data captures the item's new reorder_level (25)");

      console.log('\nA write made through a security-definer RPC is still attributed to the real calling user...');
      const { data: wo, error: woErr } = await clientStore.rpc('create_work_order', { target_output_item_id: item.id, target_qty: 5, notes_in: null });
      assert(!woErr, `store role can create a work order${woErr ? ` (${woErr.message})` : ''}`);
      if (wo) {
        workOrderIds.push(wo.id);
        const { data: woLog, error: woLogErr } = await admin
          .from('action_log')
          .select('*')
          .eq('table_name', 'work_orders')
          .eq('operation', 'INSERT')
          .eq('row_id', wo.id)
          .maybeSingle();
        assert(!!woLog, `an action_log row exists for the work order INSERT made inside create_work_order()${woLogErr ? ` (${woLogErr.message})` : ''}`);
        assert(woLog?.user_id === storeUser.id, "the log row's user_id is the store user, not the RPC's elevated owner");
      } else {
        assert(false, 'skipped the RPC-attribution check — create_work_order failed, see its message');
      }

      console.log('\nService-role-only writes (no authenticated caller) are not logged...');
      const { data: adminItem } = await admin.from('items').insert({ name: `RLS Test Admin Item Log ${stamp}` }).select().single();
      if (adminItem) itemIds.push(adminItem.id);
      const { data: adminInsertLog } = await admin.from('action_log').select('id').eq('table_name', 'items').eq('row_id', adminItem?.id).maybeSingle();
      assert(!adminInsertLog, "a service-role (no auth.uid()) insert doesn't create a log entry");

      console.log('\nDirect inserts into action_log are blocked — writes must go through the trigger...');
      const { error: directInsertErr } = await clientAdmin.from('action_log').insert({ table_name: 'items', operation: 'INSERT', row_id: item.id, user_id: adminUser.id });
      assert(!!directInsertErr, 'a direct insert into action_log is rejected (no insert policy — the trigger is the only way in)');

      console.log('\nReading the log: admin can, store cannot...');
      const { data: logForAdmin, error: logForAdminErr } = await clientAdmin.from('action_log').select('id').eq('row_id', item.id);
      assert((logForAdmin ?? []).length > 0, `admin role can read action_log entries${logForAdminErr ? ` (${logForAdminErr.message})` : ''}`);

      const { data: logForStore } = await clientStore.from('action_log').select('id').eq('row_id', item.id);
      assert((logForStore ?? []).length === 0, "store role's read of action_log comes back empty (RLS silently filters it, not an error)");
    } else if (!item) {
      assert(false, 'skipped all downstream action_log checks — the item create above failed, see its message');
    } else {
      assert(false, `skipped all action_log checks — the action_log table isn't reachable yet, likely the Phase 9 migration hasn't been applied to this project (${actionLogProbeErr.message})`);
    }
  } finally {
    console.log('\nCleaning up test data...');
    await cleanup({ userIds, workOrderIds, itemIds });
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

run().catch((err) => {
  console.error('Integration test run failed:', err.message);
  process.exit(1);
});
