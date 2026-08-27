// RLS/RPC integration tests for Phase 5's tables (invoices,
// invoice_purchase_orders), run against a REAL Supabase project — same
// pattern as test-rls-inventory.mjs. Invoices is the first module in this
// schema where RLS restricts SELECT to a narrow pair (admin/authorized),
// not company-wide — so this script also confirms an excluded role gets a
// silently empty result, not an error, same "PostgREST filters rather than
// errors" behavior already seen for UPDATEs in earlier scripts.
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

async function cleanup({ userIds, projectId, vendorId, poId, invoiceId }) {
  if (invoiceId) await admin.from('invoices').delete().eq('id', invoiceId);
  if (poId) await admin.from('purchase_orders').delete().eq('id', poId);
  if (projectId) await admin.from('projects').delete().eq('id', projectId);
  if (vendorId) await admin.from('vendors').delete().eq('id', vendorId);
  for (const id of userIds) {
    await admin.auth.admin.deleteUser(id).catch(() => {});
  }
}

async function run() {
  console.log('Setting up test users (purchase, store, authorized) and fixture PO data...');
  const purchaseUser = await createUser({ name: `RLS Test Purchase Inv2 ${stamp}`, email: `rls-purchase-inv2-${stamp}@example.com`, role: 'purchase' });
  const storeUser = await createUser({ name: `RLS Test Store Inv2 ${stamp}`, email: `rls-store-inv2-${stamp}@example.com`, role: 'store' });
  const authorizedUser = await createUser({ name: `RLS Test Authorized ${stamp}`, email: `rls-authorized-${stamp}@example.com`, role: 'authorized' });
  const userIds = [purchaseUser.id, storeUser.id, authorizedUser.id];

  let projectId, vendorId, poId, invoiceId;

  try {
    const clientPurchase = await signedInClient(purchaseUser.email);
    const clientStore = await signedInClient(storeUser.email);
    const clientAuthorized = await signedInClient(authorizedUser.email);

    const { data: project } = await admin.from('projects').insert({ name: `RLS Test Project Inv2 ${stamp}` }).select().single();
    projectId = project.id;
    const { data: vendor } = await admin.from('vendors').insert({ name: `RLS Test Vendor Inv2 ${stamp}` }).select().single();
    vendorId = vendor.id;
    const { data: po } = await admin
      .from('purchase_orders')
      .insert({ project_id: projectId, vendor_id: vendorId, order_date: '2026-01-01', created_by: purchaseUser.id })
      .select()
      .single();
    poId = po.id;

    console.log('\nInvoices: authorized/admin can create, purchase/store cannot...');
    const { data: invoice, error: invoiceErr } = await clientAuthorized
      .from('invoices')
      .insert({ vendor_id: vendorId, invoice_date: '2026-01-01', amount: 5000, created_by: authorizedUser.id })
      .select()
      .single();
    assert(!invoiceErr, `authorized role can create an invoice${invoiceErr ? ` (${invoiceErr.message})` : ''}`);
    invoiceId = invoice?.id;

    const { error: purchaseInvoiceErr } = await clientPurchase
      .from('invoices')
      .insert({ vendor_id: vendorId, invoice_date: '2026-01-01', amount: 100, created_by: purchaseUser.id });
    assert(!!purchaseInvoiceErr, 'purchase role cannot create an invoice');

    if (invoiceId) {
      console.log("\nInvoices: unlike every earlier table, read is NOT company-wide — store role's select comes back empty, not an error...");
      const { data: invoiceForStore } = await clientStore.from('invoices').select('id').eq('id', invoiceId);
      assert((invoiceForStore ?? []).length === 0, "store role's read of the invoice is silently filtered to zero rows by RLS");

      const { data: invoiceForAuthorized } = await clientAuthorized.from('invoices').select('id').eq('id', invoiceId);
      assert((invoiceForAuthorized ?? []).some((r) => r.id === invoiceId), 'authorized role can read the invoice it created');

      console.log('\nInvoice PO links: authorized/admin can link a PO, purchase cannot...');
      const { error: linkErr } = await clientAuthorized.from('invoice_purchase_orders').insert({ invoice_id: invoiceId, po_id: poId });
      assert(!linkErr, 'authorized role can link the invoice to a PO');

      const { error: purchaseLinkErr } = await clientPurchase.from('invoice_purchase_orders').insert({ invoice_id: invoiceId, po_id: poId });
      assert(!!purchaseLinkErr, 'purchase role cannot link an invoice to a PO');

      console.log('\nInvoices: authorized/admin can mark paid, store cannot (RLS silently filters the update to zero rows)...');
      const { error: markPaidErr } = await clientAuthorized.from('invoices').update({ paid_at: new Date().toISOString() }).eq('id', invoiceId);
      assert(!markPaidErr, 'authorized role can mark the invoice paid');
      const { data: afterMarkPaid } = await admin.from('invoices').select('paid_at').eq('id', invoiceId).single();
      assert(afterMarkPaid.paid_at !== null, "the invoice's paid_at persisted");

      await admin.from('invoices').update({ paid_at: null }).eq('id', invoiceId);
      await clientStore.from('invoices').update({ paid_at: new Date().toISOString() }).eq('id', invoiceId);
      const { data: afterStoreAttempt } = await admin.from('invoices').select('paid_at').eq('id', invoiceId).single();
      assert(afterStoreAttempt.paid_at === null, 'store role cannot mark an invoice paid (RLS silently filters the update to zero rows)');

      console.log('\nInvoices: authorized/admin can archive (soft delete)...');
      const { error: archiveErr } = await clientAuthorized.from('invoices').update({ deleted_at: new Date().toISOString() }).eq('id', invoiceId);
      assert(!archiveErr, 'authorized role can archive an invoice');
      const { data: afterArchive } = await admin.from('invoices').select('deleted_at').eq('id', invoiceId).single();
      assert(afterArchive.deleted_at !== null, "the invoice's deleted_at persisted");
    } else {
      assert(false, 'skipped all downstream invoice checks — the invoice create above failed, see its message');
      assert(false, 'skipped all downstream invoice checks — the invoice create above failed, see its message');
      assert(false, 'skipped all downstream invoice checks — the invoice create above failed, see its message');
      assert(false, 'skipped all downstream invoice checks — the invoice create above failed, see its message');
      assert(false, 'skipped all downstream invoice checks — the invoice create above failed, see its message');
      assert(false, 'skipped all downstream invoice checks — the invoice create above failed, see its message');
      assert(false, 'skipped all downstream invoice checks — the invoice create above failed, see its message');
    }
  } finally {
    console.log('\nCleaning up test data...');
    await cleanup({ userIds, projectId, vendorId, poId, invoiceId });
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

run().catch((err) => {
  console.error('Integration test run failed:', err.message);
  process.exit(1);
});
