// RLS/RPC integration tests for Phase 10's bill-file capability: the
// 'bill-documents' Storage bucket policies and invoices.bill_file_path/
// bill_file_name columns (see supabase/schema.sql). No new table — "Bill"
// and "Invoice" are the same record (confirmed with the user), so this
// only tests what's actually new: authorized/admin can upload/view/delete
// a bill file, purchase/store cannot — same pattern as
// test-rls-invoices.mjs.
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

const BUCKET = 'bill-documents';
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

async function cleanup({ userIds, vendorId, invoiceId, uploadedPaths }) {
  for (const path of uploadedPaths) {
    await admin.storage.from(BUCKET).remove([path]).catch(() => {});
  }
  if (invoiceId) await admin.from('invoices').delete().eq('id', invoiceId);
  if (vendorId) await admin.from('vendors').delete().eq('id', vendorId);
  for (const id of userIds) {
    await admin.auth.admin.deleteUser(id).catch(() => {});
  }
}

async function run() {
  console.log('Setting up test users (authorized, purchase) and a fixture invoice...');
  const authorizedUser = await createUser({ name: `RLS Test Authorized BP ${stamp}`, email: `rls-authorized-bp-${stamp}@example.com`, role: 'authorized' });
  const purchaseUser = await createUser({ name: `RLS Test Purchase BP ${stamp}`, email: `rls-purchase-bp-${stamp}@example.com`, role: 'purchase' });
  const userIds = [authorizedUser.id, purchaseUser.id];
  const uploadedPaths = [];

  let vendorId, invoiceId;

  try {
    const clientAuthorized = await signedInClient(authorizedUser.email);
    const clientPurchase = await signedInClient(purchaseUser.email);

    const { data: vendor } = await admin.from('vendors').insert({ name: `RLS Test Vendor BP ${stamp}` }).select().single();
    vendorId = vendor.id;
    const { data: invoice } = await admin
      .from('invoices')
      .insert({ vendor_id: vendorId, invoice_date: '2026-01-01', amount: 1000, created_by: authorizedUser.id })
      .select()
      .single();
    invoiceId = invoice.id;

    const fileBody = new Blob([`fake bill content ${stamp}`], { type: 'text/plain' });

    console.log("\nStorage: authorized role can upload a bill file, purchase role cannot...");
    const authorizedPath = `${invoiceId}/${stamp}-authorized.txt`;
    const { error: authorizedUploadErr } = await clientAuthorized.storage.from(BUCKET).upload(authorizedPath, fileBody);
    assert(!authorizedUploadErr, `authorized role can upload to ${BUCKET}${authorizedUploadErr ? ` (${authorizedUploadErr.message})` : ''}`);
    if (!authorizedUploadErr) uploadedPaths.push(authorizedPath);

    const purchasePath = `${invoiceId}/${stamp}-purchase.txt`;
    const { error: purchaseUploadErr } = await clientPurchase.storage.from(BUCKET).upload(purchasePath, fileBody);
    assert(!!purchaseUploadErr, 'purchase role cannot upload a bill file');

    if (!authorizedUploadErr) {
      console.log('\nStorage: authorized role can read back (signed URL) what it uploaded...');
      const { data: signedData, error: signErr } = await clientAuthorized.storage.from(BUCKET).createSignedUrl(authorizedPath, 60);
      assert(!signErr && !!signedData?.signedUrl, `authorized role can create a signed URL for its upload${signErr ? ` (${signErr.message})` : ''}`);

      console.log("\nStorage: purchase role's read of the bill file comes back empty/denied, not a crash...");
      const { data: purchaseSignedData } = await clientPurchase.storage.from(BUCKET).createSignedUrl(authorizedPath, 60);
      assert(!purchaseSignedData?.signedUrl, "purchase role cannot sign a URL for a bill file it can't read");

      console.log('\ninvoices.bill_file_path: recording the path on the invoice row (app-layer step, same RLS as any other invoice update)...');
      const { error: updateErr } = await clientAuthorized
        .from('invoices')
        .update({ bill_file_path: authorizedPath, bill_file_name: 'authorized.txt' })
        .eq('id', invoiceId);
      assert(!updateErr, `authorized role can record the bill file path on the invoice${updateErr ? ` (${updateErr.message})` : ''}`);
      const { data: afterUpdate } = await admin.from('invoices').select('bill_file_path, bill_file_name').eq('id', invoiceId).single();
      assert(afterUpdate?.bill_file_path === authorizedPath, 'the invoice row persisted bill_file_path');

      console.log('\nStorage: authorized role can delete the bill file it uploaded...');
      const { error: removeErr } = await clientAuthorized.storage.from(BUCKET).remove([authorizedPath]);
      assert(!removeErr, `authorized role can remove a bill file${removeErr ? ` (${removeErr.message})` : ''}`);
    } else {
      assert(false, 'skipped downstream bill-file checks — the authorized upload above failed, see its message');
      assert(false, 'skipped downstream bill-file checks — the authorized upload above failed, see its message');
      assert(false, 'skipped downstream bill-file checks — the authorized upload above failed, see its message');
      assert(false, 'skipped downstream bill-file checks — the authorized upload above failed, see its message');
    }
  } finally {
    console.log('\nCleaning up test data...');
    await cleanup({ userIds, vendorId, invoiceId, uploadedPaths });
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

run().catch((err) => {
  console.error('Integration test run failed:', err.message);
  process.exit(1);
});
