// RLS/RPC integration tests for Phase 4's tables (items, stock_movements),
// the auto-stock-in trigger from accepted inspections, and the
// current_stock view, run against a REAL Supabase project — same pattern
// and rationale as test-rls-material-inward.mjs.
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

async function cleanup({ userIds, projectId, vendorId, poIds, itemIds }) {
  for (const poId of poIds) {
    await admin.from('material_inward').delete().eq('po_id', poId);
    await admin.from('purchase_orders').delete().eq('id', poId);
  }
  for (const itemId of itemIds) {
    await admin.from('stock_movements').delete().eq('item_id', itemId);
    await admin.from('items').delete().eq('id', itemId);
  }
  if (projectId) await admin.from('projects').delete().eq('id', projectId);
  if (vendorId) await admin.from('vendors').delete().eq('id', vendorId);
  for (const id of userIds) {
    await admin.auth.admin.deleteUser(id).catch(() => {});
  }
}

async function run() {
  console.log('Setting up test users (purchase, store, inspector) and fixture data...');
  const purchaseUser = await createUser({ name: `RLS Test Purchase Inv ${stamp}`, email: `rls-purchase-inv-${stamp}@example.com`, role: 'purchase' });
  const storeUser = await createUser({ name: `RLS Test Store Inv ${stamp}`, email: `rls-store-inv-${stamp}@example.com`, role: 'store' });
  const inspectorUser = await createUser({ name: `RLS Test Inspector Inv ${stamp}`, email: `rls-inspector-inv-${stamp}@example.com`, role: 'inspector' });
  const userIds = [purchaseUser.id, storeUser.id, inspectorUser.id];

  let projectId, vendorId;
  const poIds = [];
  const itemIds = [];

  try {
    const clientPurchase = await signedInClient(purchaseUser.email);
    const clientStore = await signedInClient(storeUser.email);
    const clientInspector = await signedInClient(inspectorUser.email);

    console.log('\nItems: purchase/store/admin can create, inspector cannot...');
    const { data: item, error: itemErr } = await clientPurchase
      .from('items')
      .insert({ name: `RLS Test Item ${stamp}`, category: 'Steel', unit_of_measure: 'Nos.', reorder_level: 50 })
      .select()
      .single();
    assert(!itemErr, `purchase role can create an item${itemErr ? ` (${itemErr.message})` : ''}`);
    if (item) itemIds.push(item.id);

    const { error: storeItemErr } = await clientStore.from('items').insert({ name: `RLS Test Item Store ${stamp}` });
    assert(!storeItemErr, 'store role can create an item');
    if (!storeItemErr) {
      const { data: storeItem } = await clientStore.from('items').select('id').eq('name', `RLS Test Item Store ${stamp}`).single();
      if (storeItem) itemIds.push(storeItem.id);
    }

    const { error: inspectorItemErr } = await clientInspector.from('items').insert({ name: `RLS Test Item Inspector ${stamp}` });
    assert(!!inspectorItemErr, 'inspector role cannot create an item');

    // Everything below needs the item created above — if that insert
    // failed (e.g. this Supabase project hasn't had the Phase 4 migration
    // applied yet), skip it as an explicit failure instead of
    // dereferencing null data and crashing before cleanup runs for the
    // users/projects/vendors set up so far.
    if (item) {
      console.log('\nItems: any authenticated role can read (Inventory, PO Upload item picker)...');
      const { data: itemForInspector } = await clientInspector.from('items').select('id').eq('id', item.id);
      assert((itemForInspector ?? []).some((r) => r.id === item.id), "inspector role can see purchase's item");

      // PO fixture: one line item linked to the Item created above, so the
      // auto-stock-in trigger has something to attach to.
      const { data: project } = await admin.from('projects').insert({ name: `RLS Test Project Inv ${stamp}` }).select().single();
      projectId = project.id;
      const { data: vendor } = await admin.from('vendors').insert({ name: `RLS Test Vendor Inv ${stamp}` }).select().single();
      vendorId = vendor.id;
      const { data: po } = await admin
        .from('purchase_orders')
        .insert({ project_id: projectId, vendor_id: vendorId, order_date: '2026-01-01', created_by: purchaseUser.id })
        .select()
        .single();
      poIds.push(po.id);
      const { data: lineItem } = await admin
        .from('po_line_items')
        .insert({ po_id: po.id, item_name: `RLS Test Item ${stamp}`, quantity: 100, rate: 45, item_id: item.id })
        .select()
        .single();

      console.log('\nAuto stock-in: an accepted inspection on a linked line item creates a matching stock_movements row...');
      const { data: inward } = await clientStore
        .from('material_inward')
        .insert({ po_id: po.id, received_date: '2026-01-10', received_by: storeUser.id })
        .select()
        .single();
      const { data: inwardLine } = await clientStore
        .from('material_inward_line_items')
        .insert({ inward_id: inward.id, po_line_item_id: lineItem.id, received_qty: 100 })
        .select()
        .single();
      const { data: inspection } = await clientInspector
        .from('inspection_results')
        .insert({ inward_line_item_id: inwardLine.id, accepted_qty: 90, rejected_qty: 10, rejection_reason: 'Surface damage', inspected_by: inspectorUser.id })
        .select()
        .single();

      const { data: autoMovements } = await admin
        .from('stock_movements')
        .select('*')
        .eq('item_id', item.id)
        .eq('reference_type', 'inspection');
      assert((autoMovements ?? []).length === 1, 'exactly one auto-created stock movement exists for this inspection');
      const autoMovement = autoMovements?.[0];
      assert(autoMovement?.movement_type === 'in', "the auto-created movement's type is 'in'");
      assert(Number(autoMovement?.quantity) === 90, "the auto-created movement's quantity is the accepted_qty (90), not the full received_qty");
      assert(autoMovement?.reference_id === inspection.id, "the auto-created movement's reference_id points at the inspection");

      console.log('\ncurrent_stock view: reflects the auto stock-in, readable by any role...');
      const { data: stockAfterIn } = await clientInspector.from('current_stock').select('*').eq('item_id', item.id).single();
      assert(Number(stockAfterIn.current_qty) === 90, 'current_qty is 90 after the auto stock-in');
      assert(Number(stockAfterIn.qty_in) === 90, 'qty_in is 90');
      assert(Number(stockAfterIn.qty_out) === 0, 'qty_out is 0');

      console.log('\nStock movements: store/admin can log a manual movement, purchase/inspector cannot...');
      const { error: manualOutErr } = await clientStore
        .from('stock_movements')
        .insert({ item_id: item.id, movement_type: 'out', quantity: 30, notes: 'Manual issue', created_by: storeUser.id });
      assert(!manualOutErr, 'store role can log a manual "out" movement');

      const { error: purchaseMovementErr } = await clientPurchase
        .from('stock_movements')
        .insert({ item_id: item.id, movement_type: 'in', quantity: 10, created_by: purchaseUser.id });
      assert(!!purchaseMovementErr, 'purchase role cannot log a manual stock movement');

      const { error: inspectorMovementErr } = await clientInspector
        .from('stock_movements')
        .insert({ item_id: item.id, movement_type: 'in', quantity: 10, created_by: inspectorUser.id });
      assert(!!inspectorMovementErr, 'inspector role cannot log a manual stock movement');

      console.log('\ncurrent_stock view: reflects the manual "out" movement on top of the auto stock-in...');
      const { data: stockAfterOut } = await admin.from('current_stock').select('*').eq('item_id', item.id).single();
      assert(Number(stockAfterOut.current_qty) === 60, 'current_qty is 60 (90 in - 30 out)');
      assert(Number(stockAfterOut.qty_out) === 30, 'qty_out is 30');
    } else {
      assert(false, 'skipped all downstream item/stock checks — the item create above failed, see its message');
    }
  } finally {
    console.log('\nCleaning up test data...');
    await cleanup({ userIds, projectId, vendorId, poIds, itemIds });
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

run().catch((err) => {
  console.error('Integration test run failed:', err.message);
  process.exit(1);
});
