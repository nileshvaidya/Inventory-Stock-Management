// RLS/RPC integration tests for the delivery-challan capability (direct
// user request, mirrors Phase 10's bill-file capability): the
// 'challan-documents' Storage bucket policies and material_inward.
// challan_file_path/challan_file_name columns (see supabase/schema.sql).
// No new table — same pattern as test-rls-bill-payments.mjs, except the
// read policy is company-wide (matching material_inward's own SELECT
// policy) rather than restricted to the write role, so a third role is
// used here to confirm that distinction actually holds.
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

const BUCKET = 'challan-documents';
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

async function cleanup({ userIds, projectId, poId, inwardId, uploadedPaths }) {
  for (const path of uploadedPaths) {
    await admin.storage.from(BUCKET).remove([path]).catch(() => {});
  }
  if (inwardId) await admin.from('material_inward').delete().eq('id', inwardId);
  if (poId) await admin.from('purchase_orders').delete().eq('id', poId);
  if (projectId) await admin.from('projects').delete().eq('id', projectId);
  for (const id of userIds) {
    await admin.auth.admin.deleteUser(id).catch(() => {});
  }
}

async function run() {
  console.log('Setting up test users (store, purchase, authorized) and a fixture receipt...');
  const storeUser = await createUser({ name: `RLS Test Store Challan ${stamp}`, email: `rls-store-challan-${stamp}@example.com`, role: 'store' });
  const purchaseUser = await createUser({ name: `RLS Test Purchase Challan ${stamp}`, email: `rls-purchase-challan-${stamp}@example.com`, role: 'purchase' });
  const authorizedUser = await createUser({ name: `RLS Test Authorized Challan ${stamp}`, email: `rls-authorized-challan-${stamp}@example.com`, role: 'authorized' });
  const userIds = [storeUser.id, purchaseUser.id, authorizedUser.id];
  const uploadedPaths = [];

  let projectId, poId, inwardId;

  try {
    const clientStore = await signedInClient(storeUser.email);
    const clientPurchase = await signedInClient(purchaseUser.email);
    const clientAuthorized = await signedInClient(authorizedUser.email);

    const { data: project } = await admin.from('projects').insert({ name: `RLS Test Project Challan ${stamp}` }).select().single();
    projectId = project.id;
    const { data: po } = await admin
      .from('purchase_orders')
      .insert({ project_id: projectId, order_date: '2026-01-01', created_by: storeUser.id })
      .select()
      .single();
    poId = po.id;
    const { data: inward } = await admin
      .from('material_inward')
      .insert({ po_id: poId, received_date: '2026-01-01', received_by: storeUser.id })
      .select()
      .single();
    inwardId = inward.id;

    const fileBody = new Blob([`fake challan content ${stamp}`], { type: 'text/plain' });

    console.log('\nStorage: store role can upload a challan file, purchase role cannot...');
    const storePath = `${inwardId}/${stamp}-store.txt`;
    const { error: storeUploadErr } = await clientStore.storage.from(BUCKET).upload(storePath, fileBody);
    assert(!storeUploadErr, `store role can upload to ${BUCKET}${storeUploadErr ? ` (${storeUploadErr.message})` : ''}`);
    if (!storeUploadErr) uploadedPaths.push(storePath);

    const purchasePath = `${inwardId}/${stamp}-purchase.txt`;
    const { error: purchaseUploadErr } = await clientPurchase.storage.from(BUCKET).upload(purchasePath, fileBody);
    assert(!!purchaseUploadErr, 'purchase role cannot upload a challan file');

    if (!storeUploadErr) {
      console.log('\nStorage: any authenticated role can read back (signed URL) — company-wide, matching material_inward\'s own SELECT policy...');
      const { data: authorizedSigned, error: authorizedSignErr } = await clientAuthorized.storage.from(BUCKET).createSignedUrl(storePath, 60);
      assert(
        !authorizedSignErr && !!authorizedSigned?.signedUrl,
        `authorized role (not store/admin) can still create a signed URL for the challan${authorizedSignErr ? ` (${authorizedSignErr.message})` : ''}`
      );

      console.log('\nmaterial_inward.challan_file_path: recording the path (app-layer step, same RLS as any other material_inward update)...');
      const { error: updateErr } = await clientStore
        .from('material_inward')
        .update({ challan_file_path: storePath, challan_file_name: 'store.txt' })
        .eq('id', inwardId);
      assert(!updateErr, `store role can record the challan file path on the receipt${updateErr ? ` (${updateErr.message})` : ''}`);
      const { data: afterUpdate } = await admin.from('material_inward').select('challan_file_path, challan_file_name').eq('id', inwardId).single();
      assert(afterUpdate?.challan_file_path === storePath, "the receipt's challan_file_path persisted");

      console.log('\nStorage: store role can delete the challan file it uploaded...');
      const { error: removeErr } = await clientStore.storage.from(BUCKET).remove([storePath]);
      assert(!removeErr, `store role can remove a challan file${removeErr ? ` (${removeErr.message})` : ''}`);
    } else {
      assert(false, 'skipped downstream challan-file checks — the store upload above failed, see its message');
      assert(false, 'skipped downstream challan-file checks — the store upload above failed, see its message');
      assert(false, 'skipped downstream challan-file checks — the store upload above failed, see its message');
    }
  } finally {
    console.log('\nCleaning up test data...');
    await cleanup({ userIds, projectId, poId, inwardId, uploadedPaths });
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

run().catch((err) => {
  console.error('Integration test run failed:', err.message);
  process.exit(1);
});
