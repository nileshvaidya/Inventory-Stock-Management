// RLS/RPC integration tests for Phase 6's tables (boms, bom_components,
// bom_production_runs), the circular-reference guard trigger, and the
// record_bom_production() RPC's atomic stock-shortfall check, run against
// a REAL Supabase project — same pattern and rationale as
// test-rls-inventory.mjs.
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

async function cleanup({ userIds, bomIds, itemIds }) {
  for (const bomId of bomIds) {
    await admin.from('bom_production_runs').delete().eq('bom_id', bomId);
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
  console.log('Setting up test users (production, store, purchase) and fixture items...');
  const productionUser = await createUser({ name: `RLS Test Production ${stamp}`, email: `rls-production-${stamp}@example.com`, role: 'production' });
  const storeUser = await createUser({ name: `RLS Test Store BoM ${stamp}`, email: `rls-store-bom-${stamp}@example.com`, role: 'store' });
  const purchaseUser = await createUser({ name: `RLS Test Purchase BoM ${stamp}`, email: `rls-purchase-bom-${stamp}@example.com`, role: 'purchase' });
  const userIds = [productionUser.id, storeUser.id, purchaseUser.id];

  const itemIds = [];
  const bomIds = [];

  try {
    const clientProduction = await signedInClient(productionUser.email);
    const clientStore = await signedInClient(storeUser.email);
    const clientPurchase = await signedInClient(purchaseUser.email);

    console.log('\nSeeding items (Widget, Bolt) via the service-role client...');
    const { data: widget } = await admin.from('items').insert({ name: `RLS Test Widget ${stamp}` }).select().single();
    const { data: bolt } = await admin.from('items').insert({ name: `RLS Test Bolt ${stamp}` }).select().single();
    itemIds.push(widget.id, bolt.id);

    console.log('\nBoMs: production/admin can create, store cannot...');
    const { data: bom, error: bomErr } = await clientProduction
      .from('boms')
      .insert({ output_item_id: widget.id, output_qty: 1, created_by: productionUser.id })
      .select()
      .single();
    assert(!bomErr, `production role can create a BoM${bomErr ? ` (${bomErr.message})` : ''}`);
    if (bom) bomIds.push(bom.id);

    const { error: storeBomErr } = await clientStore.from('boms').insert({ output_item_id: widget.id, output_qty: 1, created_by: storeUser.id });
    assert(!!storeBomErr, 'store role cannot create a BoM');

    // Everything below needs the BoM created above — if that insert failed
    // (e.g. this Supabase project hasn't had the Phase 6 migration applied
    // yet), skip it as an explicit failure instead of dereferencing null
    // data and crashing before cleanup runs.
    if (bom) {
      console.log('\nAny authenticated role can read BoMs...');
      const { data: bomForStore } = await clientStore.from('boms').select('id').eq('id', bom.id);
      assert((bomForStore ?? []).some((r) => r.id === bom.id), "store role can see production's BoM");

      console.log("\nBoM components: a component can't be the recipe's own output (self-reference)...");
      const { error: selfRefErr } = await clientProduction.from('bom_components').insert({ bom_id: bom.id, component_item_id: widget.id, quantity: 1 });
      assert(!!selfRefErr, "a component that's the same item as the recipe's own output is rejected");

      console.log('\nBoM components: production can add a valid component, purchase cannot...');
      const { error: compErr } = await clientProduction.from('bom_components').insert({ bom_id: bom.id, component_item_id: bolt.id, quantity: 4 });
      assert(!compErr, `production role can add a component${compErr ? ` (${compErr.message})` : ''}`);

      const { error: purchaseCompErr } = await clientPurchase.from('bom_components').insert({ bom_id: bom.id, component_item_id: bolt.id, quantity: 1 });
      assert(!!purchaseCompErr, 'purchase role cannot add a component');

      console.log('\nCircular reference: Bolt already feeds Widget, so a recipe producing Bolt from Widget is rejected...');
      const { data: boltBom, error: boltBomErr } = await clientProduction
        .from('boms')
        .insert({ output_item_id: bolt.id, output_qty: 1, created_by: productionUser.id })
        .select()
        .single();
      assert(!boltBomErr, `production role can create a second recipe (for Bolt)${boltBomErr ? ` (${boltBomErr.message})` : ''}`);
      if (boltBom) {
        bomIds.push(boltBom.id);
        const { error: cycleErr } = await clientProduction.from('bom_components').insert({ bom_id: boltBom.id, component_item_id: widget.id, quantity: 1 });
        assert(!!cycleErr, 'a component that would create a circular BoM reference is rejected');
      } else {
        assert(false, 'skipped the cycle-guard check — the second recipe create above failed, see its message');
      }

      console.log('\nrecord_bom_production: blocks the whole thing (nothing written) when a component is short...');
      const { error: shortfallErr } = await clientProduction.rpc('record_bom_production', { target_bom_id: bom.id, qty_produced: 1000, notes_in: null });
      assert(!!shortfallErr, 'a production run is rejected when a component is short of stock');
      const { data: runsAfterShortfall } = await admin.from('bom_production_runs').select('*').eq('bom_id', bom.id);
      assert((runsAfterShortfall ?? []).length === 0, 'no production run was recorded for the rejected (shortfall) attempt');
      const { data: boltMovementsAfterShortfall } = await admin.from('stock_movements').select('*').eq('item_id', bolt.id);
      assert((boltMovementsAfterShortfall ?? []).length === 0, "no stock movement was recorded for Bolt from the rejected attempt (it's all-or-nothing)");

      console.log("\nGiving the Bolt component enough stock via a manual 'in' movement...");
      await admin.from('stock_movements').insert({ item_id: bolt.id, movement_type: 'in', quantity: 100, created_by: productionUser.id });

      console.log('\nrecord_bom_production: succeeds with sufficient stock, consuming the component and crediting the output...');
      const { error: runErr } = await clientProduction.rpc('record_bom_production', { target_bom_id: bom.id, qty_produced: 5, notes_in: 'RLS test run' });
      assert(!runErr, `a production run succeeds with sufficient stock${runErr ? ` (${runErr.message})` : ''}`);

      if (!runErr) {
        const { data: boltStock } = await admin.from('current_stock').select('*').eq('item_id', bolt.id).single();
        assert(Number(boltStock.current_qty) === 80, 'Bolt current_qty is 80 (100 in - 20 consumed for 5x Widget @ 4 each)');

        const { data: widgetStock } = await admin.from('current_stock').select('*').eq('item_id', widget.id).single();
        assert(Number(widgetStock.current_qty) === 5, "Widget current_qty is 5 (this recipe's own output, credited)");

        const { data: runs } = await admin.from('bom_production_runs').select('*').eq('bom_id', bom.id);
        assert((runs ?? []).length === 1, 'exactly one production run is now recorded');
        assert(Number(runs?.[0]?.quantity_produced) === 5, "the recorded run's quantity_produced is 5");
      } else {
        assert(false, 'skipped downstream production-run checks — the RPC call above failed, see its message');
      }

      console.log('\nrecord_bom_production: purchase/store roles are rejected server-side...');
      const { error: purchaseProdErr } = await clientPurchase.rpc('record_bom_production', { target_bom_id: bom.id, qty_produced: 1, notes_in: null });
      assert(!!purchaseProdErr, 'purchase role cannot record BoM production');
      const { error: storeProdErr } = await clientStore.rpc('record_bom_production', { target_bom_id: bom.id, qty_produced: 1, notes_in: null });
      assert(!!storeProdErr, 'store role cannot record BoM production');

      console.log('\nDirect inserts into bom_production_runs are blocked — writes must go through the RPC...');
      const { error: directInsertErr } = await clientProduction
        .from('bom_production_runs')
        .insert({ bom_id: bom.id, output_item_id: widget.id, quantity_produced: 1, produced_by: productionUser.id });
      assert(!!directInsertErr, 'a direct insert into bom_production_runs is rejected (no insert policy — the RPC is the only way in)');

      console.log('\nArchiving a recipe (soft delete): store cannot, production can...');
      await clientStore.from('boms').update({ deleted_at: new Date().toISOString() }).eq('id', bom.id);
      const { data: bomAfterStoreAttempt } = await admin.from('boms').select('deleted_at').eq('id', bom.id).single();
      assert(bomAfterStoreAttempt.deleted_at === null, "store role's archive attempt did not persist (RLS silently filtered it)");

      await clientProduction.from('boms').update({ deleted_at: new Date().toISOString() }).eq('id', bom.id);
      const { data: bomAfterProdAttempt } = await admin.from('boms').select('deleted_at').eq('id', bom.id).single();
      assert(bomAfterProdAttempt.deleted_at !== null, "production role's archive attempt persisted");
    } else {
      assert(false, 'skipped all downstream BoM checks — the BoM create above failed, see its message');
    }
  } finally {
    console.log('\nCleaning up test data...');
    await cleanup({ userIds, bomIds, itemIds });
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

run().catch((err) => {
  console.error('Integration test run failed:', err.message);
  process.exit(1);
});
