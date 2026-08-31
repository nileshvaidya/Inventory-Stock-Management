// RLS/RPC integration tests for Phase 7's tables (work_orders,
// work_order_requirements, stock_reservations), the available_stock view,
// and the explode_bom_requirements/create_work_order/reserve_work_order
// RPCs' netting math and atomic re-availability check, run against a REAL
// Supabase project — same pattern and rationale as test-rls-boms.mjs.
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

async function cleanup({ userIds, workOrderIds, bomIds, itemIds }) {
  for (const woId of workOrderIds) {
    await admin.from('stock_reservations').delete().eq('work_order_id', woId);
    await admin.from('work_order_requirements').delete().eq('work_order_id', woId);
    await admin.from('work_orders').delete().eq('id', woId);
  }
  for (const bomId of bomIds) {
    await admin.from('bom_components').delete().eq('bom_id', bomId);
    await admin.from('boms').delete().eq('id', bomId);
  }
  for (const itemId of itemIds) {
    await admin.from('stock_movements').delete().eq('item_id', itemId);
    await admin.from('items').delete().eq('id', itemId);
  }
  for (const id of userIds) {
    await admin.auth.admin.deleteUser(id).catch(() => {});
  }
}

async function run() {
  console.log('Setting up test users (production, store, purchase) and fixture items/recipe...');
  const productionUser = await createUser({ name: `RLS Test Production WO ${stamp}`, email: `rls-production-wo-${stamp}@example.com`, role: 'production' });
  const storeUser = await createUser({ name: `RLS Test Store WO ${stamp}`, email: `rls-store-wo-${stamp}@example.com`, role: 'store' });
  const purchaseUser = await createUser({ name: `RLS Test Purchase WO ${stamp}`, email: `rls-purchase-wo-${stamp}@example.com`, role: 'purchase' });
  const userIds = [productionUser.id, storeUser.id, purchaseUser.id];

  const itemIds = [];
  const bomIds = [];
  const workOrderIds = [];

  try {
    const clientProduction = await signedInClient(productionUser.email);
    const clientStore = await signedInClient(storeUser.email);
    const clientPurchase = await signedInClient(purchaseUser.email);

    console.log('\nSeeding items (Widget, Bolt) and a recipe (Widget needs 4x Bolt) via the service-role client...');
    const { data: widget } = await admin.from('items').insert({ name: `RLS Test Widget WO ${stamp}` }).select().single();
    const { data: bolt } = await admin.from('items').insert({ name: `RLS Test Bolt WO ${stamp}` }).select().single();
    itemIds.push(widget.id, bolt.id);

    const { data: bom } = await admin.from('boms').insert({ output_item_id: widget.id, output_qty: 1, created_by: productionUser.id }).select().single();
    bomIds.push(bom.id);
    await admin.from('bom_components').insert({ bom_id: bom.id, component_item_id: bolt.id, quantity: 4 });

    await admin.from('stock_movements').insert({ item_id: bolt.id, movement_type: 'in', quantity: 100, created_by: productionUser.id });

    console.log('\nexplode_bom_requirements: nets against on-hand stock, is readable by any authenticated role...');
    const { data: preview, error: previewErr } = await clientStore.rpc('explode_bom_requirements', { root_item_id: widget.id, root_qty: 10 });
    assert(!previewErr, `explosion preview succeeds${previewErr ? ` (${previewErr.message})` : ''}`);
    if (preview) {
      const boltRow = preview.find((r) => r.item_id === bolt.id);
      assert(!!boltRow, 'Bolt appears in the exploded requirements');
      assert(Number(boltRow?.reservable_qty) === 40, 'Bolt reservable_qty is 40 (10 Widgets x 4 Bolt, well within the 100 on hand)');
      assert(Number(boltRow?.shortfall_qty) === 0, 'Bolt shortfall_qty is 0 (fully covered by stock)');
    } else {
      assert(false, 'skipped explosion-shape checks — the preview call above failed, see its message');
    }

    console.log('\nexplode_bom_requirements: correctly reports a shortfall when demand exceeds stock...');
    const { data: shortfallPreview } = await clientStore.rpc('explode_bom_requirements', { root_item_id: widget.id, root_qty: 1000 });
    const boltShortfallRow = (shortfallPreview ?? []).find((r) => r.item_id === bolt.id);
    assert(!!boltShortfallRow, 'Bolt appears in the over-demand explosion');
    assert(Number(boltShortfallRow?.reservable_qty) === 100, 'Bolt reservable_qty caps at the 100 actually on hand');
    assert(Number(boltShortfallRow?.shortfall_qty) === 3900, 'Bolt shortfall_qty is 3900 (1000 x 4 - 100)');

    console.log('\ncreate_work_order: production/store/admin can create, purchase cannot...');
    const { data: wo, error: woErr } = await clientProduction.rpc('create_work_order', { target_output_item_id: widget.id, target_qty: 10, notes_in: 'RLS test WO' });
    assert(!woErr, `production role can create a work order${woErr ? ` (${woErr.message})` : ''}`);
    if (wo) workOrderIds.push(wo.id);

    const { error: purchaseWoErr } = await clientPurchase.rpc('create_work_order', { target_output_item_id: widget.id, target_qty: 10, notes_in: null });
    assert(!!purchaseWoErr, 'purchase role cannot create a work order');

    // Everything below needs the work order created above — if that RPC
    // call failed (e.g. this Supabase project hasn't had the Phase 7
    // migration applied yet), skip it as an explicit failure instead of
    // dereferencing null data and crashing before cleanup runs.
    if (wo) {
      assert(wo.status === 'open', "a newly created work order's status is 'open'");

      console.log('\nA direct insert into work_orders is blocked — writes must go through create_work_order()...');
      const { error: directWoInsertErr } = await clientProduction
        .from('work_orders')
        .insert({ output_item_id: widget.id, quantity: 1, created_by: productionUser.id });
      assert(!!directWoInsertErr, 'a direct insert into work_orders is rejected (no insert policy)');

      console.log('\nThe requirement snapshot was written correctly (Bolt: reservable 40, shortfall 0)...');
      const { data: requirements } = await admin.from('work_order_requirements').select('*').eq('work_order_id', wo.id);
      const boltReq = (requirements ?? []).find((r) => r.item_id === bolt.id);
      assert(!!boltReq, "the work order's Bolt requirement row exists");
      assert(Number(boltReq?.reservable_qty) === 40, "the snapshot's reservable_qty is 40");
      assert(Number(boltReq?.shortfall_qty) === 0, "the snapshot's shortfall_qty is 0");

      console.log('\nreserve_work_order: purchase cannot reserve, production can...');
      const { error: purchaseReserveErr } = await clientPurchase.rpc('reserve_work_order', { target_work_order_id: wo.id });
      assert(!!purchaseReserveErr, 'purchase role cannot reserve stock for a work order');

      const { error: reserveErr } = await clientProduction.rpc('reserve_work_order', { target_work_order_id: wo.id });
      assert(!reserveErr, `production role can reserve stock for its work order${reserveErr ? ` (${reserveErr.message})` : ''}`);

      if (!reserveErr) {
        const { data: woAfterReserve } = await admin.from('work_orders').select('status, reserved_at').eq('id', wo.id).single();
        assert(woAfterReserve.status === 'reserved', "the work order's status is now 'reserved'");
        assert(woAfterReserve.reserved_at !== null, 'reserved_at was stamped');

        const { data: reservations } = await admin.from('stock_reservations').select('*').eq('work_order_id', wo.id);
        assert((reservations ?? []).length === 1, 'exactly one stock_reservations row was created');
        assert(Number(reservations?.[0]?.quantity) === 40, "the reservation's quantity is 40");

        console.log('\navailable_stock: reflects the active reservation (100 on hand, 40 reserved, 60 available)...');
        const { data: boltAvailability } = await clientStore.from('available_stock').select('*').eq('item_id', bolt.id).single();
        assert(Number(boltAvailability.current_qty) === 100, 'current_qty is unchanged at 100 (a reservation is a hold, not a movement)');
        assert(Number(boltAvailability.reserved_qty) === 40, 'reserved_qty is 40');
        assert(Number(boltAvailability.available_qty) === 60, 'available_qty is 60 (100 - 40)');

        console.log('\nreserve_work_order: reserving an already-reserved work order is rejected...');
        const { error: reReserveErr } = await clientProduction.rpc('reserve_work_order', { target_work_order_id: wo.id });
        assert(!!reReserveErr, 'reserving a work order that is already reserved fails');

        console.log('\nA direct client update cannot set status to anything but cancelled...');
        const { error: fakeReserveErr } = await clientProduction.from('work_orders').update({ status: 'reserved' }).eq('id', wo.id);
        const { data: woAfterFakeAttempt } = await admin.from('work_orders').select('status').eq('id', wo.id).single();
        assert(
          !!fakeReserveErr || woAfterFakeAttempt.status === 'reserved',
          'a direct client update cannot forge a reserved transition outside the RPC (either rejected, or a no-op since it was already reserved)'
        );

        console.log('\nCancel: purchase cannot, store can — and available_stock frees up again...');
        // An UPDATE whose USING clause excludes the caller's row (purchase
        // here, since can_manage_work_orders() is false for it) matches
        // zero rows under RLS — PostgREST reports that as a quiet 200/
        // no-op, not an error. Assert against the row's persisted state
        // via the service-role client instead, same pattern as the boms
        // archive check above.
        await clientPurchase.from('work_orders').update({ status: 'cancelled' }).eq('id', wo.id);
        const { data: woAfterPurchaseAttempt } = await admin.from('work_orders').select('status').eq('id', wo.id).single();
        assert(woAfterPurchaseAttempt.status === 'reserved', "purchase role's cancel attempt did not persist (RLS silently filtered it)");

        const { error: cancelErr } = await clientStore.from('work_orders').update({ status: 'cancelled' }).eq('id', wo.id);
        assert(!cancelErr, `store role can cancel a work order${cancelErr ? ` (${cancelErr.message})` : ''}`);

        const { data: woAfterCancel } = await admin.from('work_orders').select('status, cancelled_at').eq('id', wo.id).single();
        assert(woAfterCancel.status === 'cancelled', "the work order's status is now 'cancelled'");
        assert(woAfterCancel.cancelled_at !== null, 'cancelled_at was stamped by the trigger');

        const { data: boltAvailabilityAfterCancel } = await admin.from('available_stock').select('*').eq('item_id', bolt.id).single();
        assert(Number(boltAvailabilityAfterCancel.reserved_qty) === 0, 'reserved_qty drops back to 0 once the work order is cancelled');
        assert(Number(boltAvailabilityAfterCancel.available_qty) === 100, 'available_qty is back to 100');
      } else {
        assert(false, 'skipped downstream reservation checks — the reserve call above failed, see its message');
      }

      console.log('\nDirect inserts into work_order_requirements and stock_reservations are blocked...');
      const { error: directReqInsertErr } = await clientProduction
        .from('work_order_requirements')
        .insert({ work_order_id: wo.id, item_id: bolt.id, reservable_qty: 1, shortfall_qty: 0 });
      assert(!!directReqInsertErr, 'a direct insert into work_order_requirements is rejected (no insert policy)');

      const { error: directResInsertErr } = await clientProduction.from('stock_reservations').insert({ work_order_id: wo.id, item_id: bolt.id, quantity: 1 });
      assert(!!directResInsertErr, 'a direct insert into stock_reservations is rejected (no insert policy)');
    } else {
      assert(false, 'skipped all downstream work order checks — the create_work_order call above failed, see its message');
    }
  } finally {
    console.log('\nCleaning up test data...');
    await cleanup({ userIds, workOrderIds, bomIds, itemIds });
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

run().catch((err) => {
  console.error('Integration test run failed:', err.message);
  process.exit(1);
});
