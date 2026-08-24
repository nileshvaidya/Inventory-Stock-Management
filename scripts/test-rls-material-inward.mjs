// RLS/RPC integration tests for Phase 3's tables (material_inward,
// material_inward_line_items, inspection_results) and the
// recompute_po_status trigger + master_material_status view, run against a
// REAL Supabase project — same pattern and rationale as
// test-rls-purchase-orders.mjs.
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

async function poStatus(poId) {
  const { data } = await admin.from('purchase_orders').select('status').eq('id', poId).single();
  return data?.status;
}

async function cleanup({ userIds, projectId, vendorId, poIds }) {
  for (const poId of poIds) {
    await admin.from('material_inward').delete().eq('po_id', poId);
    await admin.from('purchase_orders').delete().eq('id', poId);
  }
  if (projectId) await admin.from('projects').delete().eq('id', projectId);
  if (vendorId) await admin.from('vendors').delete().eq('id', vendorId);
  for (const id of userIds) {
    await admin.auth.admin.deleteUser(id).catch(() => {});
  }
}

async function run() {
  console.log('Setting up test users (purchase, store, inspector) and fixture PO data...');
  const purchaseUser = await createUser({ name: `RLS Test Purchase MI ${stamp}`, email: `rls-purchase-mi-${stamp}@example.com`, role: 'purchase' });
  const storeUser = await createUser({ name: `RLS Test Store ${stamp}`, email: `rls-store-mi-${stamp}@example.com`, role: 'store' });
  const inspectorUser = await createUser({ name: `RLS Test Inspector ${stamp}`, email: `rls-inspector-${stamp}@example.com`, role: 'inspector' });
  const userIds = [purchaseUser.id, storeUser.id, inspectorUser.id];

  let projectId, vendorId;
  const poIds = [];

  try {
    const clientStore = await signedInClient(storeUser.email);
    const clientInspector = await signedInClient(inspectorUser.email);

    const { data: project } = await admin.from('projects').insert({ name: `RLS Test Project MI ${stamp}` }).select().single();
    projectId = project.id;
    const { data: vendor } = await admin.from('vendors').insert({ name: `RLS Test Vendor MI ${stamp}` }).select().single();
    vendorId = vendor.id;

    // PO A: full lifecycle — partial receipt, then complete, then a mixed
    // accept/reject inspection (should NOT fully reject the PO).
    const { data: poA } = await admin
      .from('purchase_orders')
      .insert({ project_id: projectId, vendor_id: vendorId, order_date: '2026-01-01', created_by: purchaseUser.id })
      .select()
      .single();
    poIds.push(poA.id);
    const { data: lineA } = await admin
      .from('po_line_items')
      .insert({ po_id: poA.id, item_name: 'Base Angle', quantity: 100, rate: 45 })
      .select()
      .single();

    console.log('\nMaterial inward: store role can create, inspector role cannot (P3)...');
    const { data: inwardA1, error: inwardA1Err } = await clientStore
      .from('material_inward')
      .insert({ po_id: poA.id, received_date: '2026-01-10', received_by: storeUser.id })
      .select()
      .single();
    assert(!inwardA1Err, 'store role can create a material inward header');

    const { error: inwardLineErr } = await clientStore
      .from('material_inward_line_items')
      .insert({ inward_id: inwardA1.id, po_line_item_id: lineA.id, received_qty: 40 });
    assert(!inwardLineErr, 'store role can add a received-qty line to material inward');

    const { error: inspectorInwardErr } = await clientInspector
      .from('material_inward')
      .insert({ po_id: poA.id, received_date: '2026-01-10', received_by: inspectorUser.id });
    assert(!!inspectorInwardErr, 'inspector role cannot create material inward');

    console.log('\nrecompute_po_status: a partial receipt (40 of 100) sets the PO to partially_received...');
    assert((await poStatus(poA.id)) === 'partially_received', 'PO status is partially_received after a 40/100 receipt');

    console.log('\nMaterial inward: any authenticated role can read (Master Material Status)...');
    const { data: inwardForInspector } = await clientInspector.from('material_inward').select('id').eq('po_id', poA.id);
    assert((inwardForInspector ?? []).some((r) => r.id === inwardA1.id), "inspector role can see store's inward record");

    console.log("\nCompleting PO A's receipt (60 more, totaling 100)...");
    const { data: inwardA2 } = await clientStore
      .from('material_inward')
      .insert({ po_id: poA.id, received_date: '2026-01-11', received_by: storeUser.id })
      .select()
      .single();
    const { data: inwardLineA2 } = await clientStore
      .from('material_inward_line_items')
      .insert({ inward_id: inwardA2.id, po_line_item_id: lineA.id, received_qty: 60 })
      .select()
      .single();
    const { data: inwardLineA1 } = await admin
      .from('material_inward_line_items')
      .select('id')
      .eq('inward_id', inwardA1.id)
      .single();
    assert((await poStatus(poA.id)) === 'material_received', 'PO status is material_received once all 100 units are in');

    console.log('\nInspection results: inspector role can create, store role cannot...');
    const { error: insp1Err } = await clientInspector
      .from('inspection_results')
      .insert({ inward_line_item_id: inwardLineA1.id, accepted_qty: 40, rejected_qty: 0, inspected_by: inspectorUser.id });
    assert(!insp1Err, 'inspector role can record an accepted-only inspection');

    const { error: storeInspectionErr } = await clientStore
      .from('inspection_results')
      .insert({ inward_line_item_id: inwardLineA2.id, accepted_qty: 60, rejected_qty: 0, inspected_by: storeUser.id });
    assert(!!storeInspectionErr, 'store role cannot create inspection results');

    console.log('\nrecompute_po_status: a partial rejection (10 of the remaining 60) still shows received_inspected, not rejected (confirmed semantics)...');
    const { error: insp2Err } = await clientInspector.from('inspection_results').insert({
      inward_line_item_id: inwardLineA2.id,
      accepted_qty: 50,
      rejected_qty: 10,
      rejection_reason: 'Surface damage on 10 units',
      inspected_by: inspectorUser.id,
    });
    assert(!insp2Err, 'inspector role can record a partial accept/reject inspection with a reason');
    assert((await poStatus(poA.id)) === 'received_inspected', 'PO status is received_inspected — a partial rejection does not flip the whole PO to rejected');

    console.log('\nInspection results: rejecting without a reason is refused at the DB layer...');
    const { data: lineB } = await admin
      .from('po_line_items')
      .insert({ po_id: poA.id, item_name: 'Test Bolt', quantity: 5, rate: 1 })
      .select()
      .single();
    const { data: inwardB } = await clientStore
      .from('material_inward')
      .insert({ po_id: poA.id, received_date: '2026-01-12', received_by: storeUser.id })
      .select()
      .single();
    const { data: inwardLineB } = await clientStore
      .from('material_inward_line_items')
      .insert({ inward_id: inwardB.id, po_line_item_id: lineB.id, received_qty: 5 })
      .select()
      .single();
    const { error: noReasonErr } = await clientInspector
      .from('inspection_results')
      .insert({ inward_line_item_id: inwardLineB.id, accepted_qty: 0, rejected_qty: 5, inspected_by: inspectorUser.id });
    assert(!!noReasonErr, 'a rejection with zero rejection_reason is rejected by the DB check constraint');

    console.log('\nMaster Material Status view: reflects the true accepted/rejected/pending split, readable by any role...');
    const { data: statusRows } = await clientStore.from('master_material_status').select('*').eq('po_id', poA.id).order('item_name');
    const baseAngleRow = statusRows.find((r) => r.po_line_item_id === lineA.id);
    assert(Number(baseAngleRow.ordered_qty) === 100, 'Base Angle: ordered_qty is 100');
    assert(Number(baseAngleRow.received_qty) === 100, 'Base Angle: received_qty is 100');
    assert(Number(baseAngleRow.accepted_qty) === 90, 'Base Angle: accepted_qty is 90');
    assert(Number(baseAngleRow.rejected_qty) === 10, 'Base Angle: rejected_qty is 10');
    assert(Number(baseAngleRow.pending_qty) === 0, 'Base Angle: pending_qty is 0');

    // PO B: a fully-rejected order — every unit received and inspected,
    // none accepted — is the one case that DOES flip the PO to 'rejected'.
    console.log("\nrecompute_po_status: a fully-rejected order (0 accepted) sets the PO to 'rejected'...");
    const { data: poB } = await admin
      .from('purchase_orders')
      .insert({ project_id: projectId, vendor_id: vendorId, order_date: '2026-01-01', created_by: purchaseUser.id })
      .select()
      .single();
    poIds.push(poB.id);
    const { data: lineC } = await admin
      .from('po_line_items')
      .insert({ po_id: poB.id, item_name: 'Faulty Batch', quantity: 10, rate: 20 })
      .select()
      .single();
    const { data: inwardC } = await clientStore
      .from('material_inward')
      .insert({ po_id: poB.id, received_date: '2026-01-15', received_by: storeUser.id })
      .select()
      .single();
    const { data: inwardLineC } = await clientStore
      .from('material_inward_line_items')
      .insert({ inward_id: inwardC.id, po_line_item_id: lineC.id, received_qty: 10 })
      .select()
      .single();
    await clientInspector.from('inspection_results').insert({
      inward_line_item_id: inwardLineC.id,
      accepted_qty: 0,
      rejected_qty: 10,
      rejection_reason: 'Entire batch failed QC',
      inspected_by: inspectorUser.id,
    });
    assert((await poStatus(poB.id)) === 'rejected', "PO status is 'rejected' when every received unit was rejected");
  } finally {
    console.log('\nCleaning up test data...');
    await cleanup({ userIds, projectId, vendorId, poIds });
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

run().catch((err) => {
  console.error('Integration test run failed:', err.message);
  process.exit(1);
});
