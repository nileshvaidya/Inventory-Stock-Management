// RLS/RPC integration tests for Phase 2's tables (vendors, projects,
// purchase_orders, po_line_items, import_field_mappings), run against a
// REAL Supabase project — same pattern and rationale as test-rls-users.mjs.
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

async function cleanup({ userIds, projectId, vendorId, poId, mappingId, inwardId }) {
  if (mappingId) await admin.from('import_field_mappings').delete().eq('id', mappingId);
  // Deleted before the PO itself — material_inward_line_items.po_line_item_id
  // has no ON DELETE CASCADE from po_line_items (deliberately, see
  // supabase/schema.sql), so a leftover receipt fixture would otherwise
  // block po_line_items' own cascade off purchase_orders' delete below,
  // leaking the PO (and in turn the project/vendor it still references).
  if (inwardId) await admin.from('material_inward').delete().eq('id', inwardId);
  if (poId) await admin.from('purchase_orders').delete().eq('id', poId);
  if (projectId) await admin.from('projects').delete().eq('id', projectId);
  if (vendorId) await admin.from('vendors').delete().eq('id', vendorId);
  for (const id of userIds) {
    await admin.auth.admin.deleteUser(id).catch(() => {});
  }
}

async function run() {
  console.log('Setting up test users (one purchase, one store, one admin)...');
  const purchaseUser = await createUser({ name: `RLS Test Purchase ${stamp}`, email: `rls-purchase-${stamp}@example.com`, role: 'purchase' });
  const storeUser = await createUser({ name: `RLS Test Store ${stamp}`, email: `rls-store-po-${stamp}@example.com`, role: 'store' });
  const adminUser = await createUser({ name: `RLS Test Admin ${stamp}`, email: `rls-admin-po-${stamp}@example.com`, role: 'admin' });
  const userIds = [purchaseUser.id, storeUser.id, adminUser.id];
  let projectId, vendorId, poId, mappingId, inwardId;

  try {
    const clientPurchase = await signedInClient(purchaseUser.email);
    const clientStore = await signedInClient(storeUser.email);
    const clientAdmin = await signedInClient(adminUser.email);

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

    console.log('\nPurchase orders: soft delete (Order Status "Delete") — admin can archive, purchase/store cannot (admin-only, per user request)...');
    // Postgres RLS filters an UPDATE's USING clause before the statement
    // ever runs — for a caller the policy excludes, that's zero matching
    // rows, which PostgREST reports as a quiet 200/no-op, not an error.
    // The real assertion is whether the row actually changed, not whether
    // the client call "errored".
    await clientPurchase.from('purchase_orders').update({ deleted_at: new Date().toISOString() }).eq('id', poId);
    const { data: afterPurchaseAttempt } = await admin.from('purchase_orders').select('deleted_at').eq('id', poId).single();
    assert(afterPurchaseAttempt.deleted_at === null, 'purchase role cannot archive a PO (RLS silently filters the update to zero rows)');

    await clientStore.from('purchase_orders').update({ deleted_at: new Date().toISOString() }).eq('id', poId);
    const { data: afterStoreAttempt } = await admin.from('purchase_orders').select('deleted_at').eq('id', poId).single();
    assert(afterStoreAttempt.deleted_at === null, 'store role cannot archive a PO (RLS silently filters the update to zero rows)');

    const { error: archiveErr } = await clientAdmin
      .from('purchase_orders')
      .update({ deleted_at: new Date().toISOString() })
      .eq('id', poId);
    assert(!archiveErr, 'admin role can archive (soft-delete) a PO');
    const { data: afterArchive } = await admin.from('purchase_orders').select('deleted_at').eq('id', poId).single();
    assert(afterArchive.deleted_at !== null, "the PO's deleted_at persisted");

    await admin.from('purchase_orders').update({ deleted_at: null }).eq('id', poId);

    console.log('\nPurchase orders: editing (Order Status "double-click to edit") — admin_update_purchase_order() is admin-only...');
    const { data: lineItemB, error: lineItemBErr } = await clientPurchase
      .from('po_line_items')
      .insert({ po_id: poId, item_name: 'Test Gadget', quantity: 5, rate: 2 })
      .select()
      .single();
    assert(!lineItemBErr, 'purchase role can add a second line item to their PO (for the edit tests below)');
    const lineItemBId = lineItemB?.id;

    // Fixture: a receipt against the PO's first line item, so the edit
    // RPC's "can't remove a line item material has already been received
    // against" guard below has something real to trip on. Set up directly
    // via the service-role client — material inward's own RLS is covered
    // by phase3's RLS script, not this one.
    const { data: firstLineItem } = await admin.from('po_line_items').select('id').eq('po_id', poId).neq('id', lineItemBId).single();
    const { data: inward, error: inwardErr } = await admin.from('material_inward').insert({ po_id: poId, received_by: storeUser.id }).select().single();
    assert(!inwardErr, 'fixture: material inward record created');
    inwardId = inward?.id;
    const { error: inwardLineErr } = await admin
      .from('material_inward_line_items')
      .insert({ inward_id: inwardId, po_line_item_id: firstLineItem.id, received_qty: 3 });
    assert(!inwardLineErr, 'fixture: material received against the first line item');

    const editPayload = (lineItems) => ({
      target_po_id: poId,
      po_number_in: 'PO-EDITED',
      project_id_in: projectId,
      vendor_id_in: vendorId,
      order_date_in: '2026-01-02',
      payment_terms_days_in: 15,
      stated_total_in: 75,
      line_items_in: lineItems,
    });

    const { error: purchaseEditErr } = await clientPurchase.rpc(
      'admin_update_purchase_order',
      editPayload([
        { id: firstLineItem.id, item_name: 'Test Widget', quantity: 10, rate: 5, item_id: null },
        { id: lineItemBId, item_name: 'Test Gadget', quantity: 5, rate: 2, item_id: null },
      ])
    );
    assert(!!purchaseEditErr, 'purchase role cannot call admin_update_purchase_order (admin-only)');

    console.log('\nPurchase orders: admin can edit header fields and line items — update in place, add a new one, remove one with no receipts against it...');
    const { error: adminEditErr } = await clientAdmin.rpc(
      'admin_update_purchase_order',
      // lineItemB deliberately omitted — it has no receipts against it, so
      // it should be removed rather than blocked.
      editPayload([{ id: firstLineItem.id, item_name: 'Test Widget (rev)', quantity: 10, rate: 6, item_id: null }, { item_name: 'Test Widget New Row', quantity: 2, rate: 3, item_id: null }])
    );
    assert(!adminEditErr, `admin can edit the PO${adminEditErr ? ` (${adminEditErr.message})` : ''}`);

    const { data: afterEdit } = await admin.from('purchase_orders').select('po_number, payment_terms_days, stated_total').eq('id', poId).single();
    assert(afterEdit?.po_number === 'PO-EDITED', "the PO's edited header fields persisted");
    assert(afterEdit?.payment_terms_days === 15, 'payment terms persisted');

    const { data: lineItemsAfterEdit } = await admin.from('po_line_items').select('id, item_name, quantity, rate').eq('po_id', poId).order('created_at');
    assert(lineItemsAfterEdit?.length === 2, 'the PO now has exactly two line items — the edited original plus the new row, with the omitted one removed');
    assert(
      lineItemsAfterEdit?.some((li) => li.id === firstLineItem.id && Number(li.rate) === 6),
      "the first line item's rate was updated in place (same id), not replaced"
    );
    assert(!lineItemsAfterEdit?.some((li) => li.id === lineItemBId), 'the omitted line item (no receipts against it) was removed');

    console.log("\nPurchase orders: editing cannot remove a line item that already has material received against it...");
    const { error: blockedRemovalErr } = await clientAdmin.rpc(
      'admin_update_purchase_order',
      // Omits firstLineItem, which has the receipt fixture set up above.
      editPayload((lineItemsAfterEdit ?? []).filter((li) => li.id !== firstLineItem.id).map((li) => ({ id: li.id, item_name: li.item_name, quantity: li.quantity, rate: li.rate, item_id: null })))
    );
    assert(!!blockedRemovalErr, 'removing a line item that already has material received against it is rejected, not silently corrupted');
    const { data: firstLineItemStillThere } = await admin.from('po_line_items').select('id').eq('id', firstLineItem.id);
    assert((firstLineItemStillThere ?? []).length === 1, 'the line item with a receipt against it is still there');

    console.log('\nImport field mappings (Map Fields Manually, Phase 2 addendum): purchase role can save one, store role cannot...');
    const templateV1 = { tokenCount: 5, itemNameTokenIndices: [0, 1], qtyTokenIndex: 2, rateTokenIndex: 3 };
    const { data: mapping, error: mappingErr } = await clientPurchase
      .from('import_field_mappings')
      .insert({ doc_type: 'purchase_order', vendor_id: vendorId, template: templateV1, created_by: purchaseUser.id })
      .select()
      .single();
    assert(!mappingErr, `purchase role can create an import field mapping${mappingErr ? ` (${mappingErr.message})` : ''}`);
    mappingId = mapping?.id;

    const { error: storeMappingErr } = await clientStore
      .from('import_field_mappings')
      .insert({ doc_type: 'purchase_order', vendor_id: vendorId, template: templateV1, created_by: storeUser.id });
    assert(!!storeMappingErr, 'store role cannot create an import field mapping');

    // The remaining assertions in this block need the row the insert above
    // created — if that insert failed (e.g. this Supabase project hasn't
    // had the import_field_mappings migration applied yet), skip them as
    // explicit failures instead of dereferencing null data and crashing
    // before cleanup runs for the PO/project/vendor set up earlier.
    if (mappingId) {
      console.log('\nImport field mappings: any authenticated role can read (auto-applied on future uploads)...');
      const { data: mappingForStore } = await clientStore
        .from('import_field_mappings')
        .select('id, template')
        .eq('id', mappingId);
      assert((mappingForStore ?? []).some((m) => m.id === mappingId), "store role can read purchase's saved mapping");

      console.log('\nImport field mappings: purchase role can update (re-map) an existing template, store role cannot...');
      const templateV2 = { ...templateV1, rateTokenIndex: 4 };
      const { error: updateMappingErr } = await clientPurchase
        .from('import_field_mappings')
        .update({ template: templateV2 })
        .eq('id', mappingId);
      assert(!updateMappingErr, 'purchase role can update its vendor mapping');
      const { data: afterUpdate } = await admin.from('import_field_mappings').select('template').eq('id', mappingId).single();
      assert(afterUpdate?.template?.rateTokenIndex === 4, "the mapping's updated template persisted");

      await clientStore.from('import_field_mappings').update({ template: templateV1 }).eq('id', mappingId);
      const { data: afterStoreMappingAttempt } = await admin
        .from('import_field_mappings')
        .select('template')
        .eq('id', mappingId)
        .single();
      assert(
        afterStoreMappingAttempt?.template?.rateTokenIndex === 4,
        'store role cannot update an import field mapping (RLS silently filters the update to zero rows)'
      );
    } else {
      assert(false, 'skipped read/update mapping checks — the create above failed, see its message');
      assert(false, 'skipped read/update mapping checks — the create above failed, see its message');
      assert(false, 'skipped read/update mapping checks — the create above failed, see its message');
    }
  } finally {
    console.log('\nCleaning up test data...');
    await cleanup({ userIds, projectId, vendorId, poId, mappingId, inwardId });
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

run().catch((err) => {
  console.error('Integration test run failed:', err.message);
  process.exit(1);
});
