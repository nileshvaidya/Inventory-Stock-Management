// RLS/RPC integration tests for Phase 2's tables (vendors, projects,
// purchase_orders, po_line_items), run against a REAL Supabase project —
// same pattern and rationale as test-rls-users.mjs.
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

async function cleanup({ userIds, projectId, vendorId, poId }) {
  if (poId) await admin.from('purchase_orders').delete().eq('id', poId);
  if (projectId) await admin.from('projects').delete().eq('id', projectId);
  if (vendorId) await admin.from('vendors').delete().eq('id', vendorId);
  for (const id of userIds) {
    await admin.auth.admin.deleteUser(id).catch(() => {});
  }
}

async function run() {
  console.log('Setting up test users (one purchase, one store)...');
  const purchaseUser = await createUser({ name: `RLS Test Purchase ${stamp}`, email: `rls-purchase-${stamp}@example.com`, role: 'purchase' });
  const storeUser = await createUser({ name: `RLS Test Store ${stamp}`, email: `rls-store-po-${stamp}@example.com`, role: 'store' });
  const userIds = [purchaseUser.id, storeUser.id];
  let projectId, vendorId, poId;

  try {
    const clientPurchase = await signedInClient(purchaseUser.email);
    const clientStore = await signedInClient(storeUser.email);

    console.log('\nProjects: purchase role can create, store role cannot (P2-3, P2-4)...');
    const { data: project, error: projectErr } = await clientPurchase
      .from('projects')
      .insert({ name: `RLS Test Project ${stamp}` })
      .select()
      .single();
    assert(!projectErr, 'purchase role can create a project');
    projectId = project?.id;

    const { error: storeProjectErr } = await clientStore.from('projects').insert({ name: `RLS Test Project (store) ${stamp}` });
    assert(!!storeProjectErr, 'store role cannot create a project');

    console.log('\nProjects: any authenticated role can read (company-wide)...');
    const { data: projectsForStore } = await clientStore.from('projects').select('id').eq('id', projectId);
    assert((projectsForStore ?? []).some((p) => p.id === projectId), 'store role can see the project purchase created');

    console.log('\nVendors: purchase role can create, store role cannot...');
    const { data: vendor, error: vendorErr } = await clientPurchase
      .from('vendors')
      .insert({ name: `RLS Test Vendor ${stamp}` })
      .select()
      .single();
    assert(!vendorErr, 'purchase role can create a vendor');
    vendorId = vendor?.id;

    const { error: storeVendorErr } = await clientStore.from('vendors').insert({ name: `RLS Test Vendor (store) ${stamp}` });
    assert(!!storeVendorErr, 'store role cannot create a vendor');

    console.log('\nPurchase orders: purchase role can create a PO + line items, store role cannot create a PO...');
    const { data: po, error: poErr } = await clientPurchase
      .from('purchase_orders')
      .insert({ project_id: projectId, vendor_id: vendorId, order_date: '2026-01-01', created_by: purchaseUser.id })
      .select()
      .single();
    assert(!poErr, 'purchase role can create a purchase order');
    poId = po?.id;

    const { error: lineItemErr } = await clientPurchase
      .from('po_line_items')
      .insert({ po_id: poId, item_name: 'Test Widget', quantity: 10, rate: 5 });
    assert(!lineItemErr, 'purchase role can add a line item to their PO');

    const { error: storePoErr } = await clientStore
      .from('purchase_orders')
      .insert({ project_id: projectId, order_date: '2026-01-01', created_by: storeUser.id });
    assert(!!storePoErr, 'store role cannot create a purchase order');

    console.log('\nPurchase orders: any authenticated role can read (Order Status, Master Material Status)...');
    const { data: poForStore } = await clientStore.from('purchase_orders').select('id').eq('id', poId);
    assert((poForStore ?? []).some((p) => p.id === poId), "store role can see purchase's PO in Order Status");

    console.log('\nPurchase orders: soft delete (P2 archive) — purchase role can archive, store role cannot...');
    const { error: archiveErr } = await clientPurchase
      .from('purchase_orders')
      .update({ deleted_at: new Date().toISOString() })
      .eq('id', poId);
    assert(!archiveErr, 'purchase role can archive (soft-delete) a PO');
    const { data: afterArchive } = await admin.from('purchase_orders').select('deleted_at').eq('id', poId).single();
    assert(afterArchive.deleted_at !== null, "the PO's deleted_at persisted");

    await admin.from('purchase_orders').update({ deleted_at: null }).eq('id', poId);
    // Postgres RLS filters an UPDATE's USING clause before the statement
    // ever runs — for a caller the policy excludes, that's zero matching
    // rows, which PostgREST reports as a quiet 200/no-op, not an error.
    // The real assertion is whether the row actually changed, not whether
    // the client call "errored".
    await clientStore.from('purchase_orders').update({ deleted_at: new Date().toISOString() }).eq('id', poId);
    const { data: afterStoreAttempt } = await admin.from('purchase_orders').select('deleted_at').eq('id', poId).single();
    assert(afterStoreAttempt.deleted_at === null, 'store role cannot archive a PO (RLS silently filters the update to zero rows)');
  } finally {
    console.log('\nCleaning up test data...');
    await cleanup({ userIds, projectId, vendorId, poId });
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

run().catch((err) => {
  console.error('Integration test run failed:', err.message);
  process.exit(1);
});
