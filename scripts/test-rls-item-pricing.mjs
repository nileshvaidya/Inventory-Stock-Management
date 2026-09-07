// RLS/RPC integration tests for Phase 12's item_price_history table and
// its two views (item_current_rate, stock_valuation), run against a REAL
// Supabase project — same pattern and rationale as test-rls-inventory.mjs.
// In particular this verifies: only can_manage_items roles (admin/
// purchase/store) can record a rate, a rate change never overwrites the
// previous entry (both stay queryable), item_current_rate always resolves
// to the most recent by effective_date, and stock_valuation's stock_value
// is current_qty * that rate (null, not zero, when no rate exists yet).
// Also covers the Phase 12 addendum's stock_statement_for_range() —
// Opening/Inward/Outward/Closing math for a date range, and the
// as-of-dateTo rate resolution the Stock Statement screen depends on.
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

async function cleanup({ userIds, itemIds }) {
  for (const itemId of itemIds) {
    await admin.from('item_price_history').delete().eq('item_id', itemId);
    await admin.from('stock_movements').delete().eq('item_id', itemId);
    await admin.from('items').delete().eq('id', itemId);
  }
  for (const id of userIds) {
    await admin.auth.admin.deleteUser(id).catch(() => {});
  }
}

async function run() {
  console.log('Setting up test users (purchase, store, production) and a fixture item...');
  const purchaseUser = await createUser({ name: `RLS Test Purchase Price ${stamp}`, email: `rls-purchase-price-${stamp}@example.com`, role: 'purchase' });
  const storeUser = await createUser({ name: `RLS Test Store Price ${stamp}`, email: `rls-store-price-${stamp}@example.com`, role: 'store' });
  const productionUser = await createUser({ name: `RLS Test Production Price ${stamp}`, email: `rls-production-price-${stamp}@example.com`, role: 'production' });
  const userIds = [purchaseUser.id, storeUser.id, productionUser.id];

  const itemIds = [];

  try {
    const clientPurchase = await signedInClient(purchaseUser.email);
    const clientStore = await signedInClient(storeUser.email);
    const clientProduction = await signedInClient(productionUser.email);

    console.log('\nSeeding a fixture item (Gadget) with 20 on hand via the service-role client...');
    const { data: item } = await admin.from('items').insert({ name: `RLS Test Gadget Price ${stamp}` }).select().single();
    itemIds.push(item.id);
    await admin.from('stock_movements').insert({ item_id: item.id, movement_type: 'in', quantity: 20, created_by: storeUser.id });

    console.log('\nitem_current_rate / stock_valuation: an item with no rate ever recorded has a null rate and stock_value, not zero...');
    const { data: rateBefore } = await admin.from('item_current_rate').select('*').eq('item_id', item.id).maybeSingle();
    assert(rateBefore === null, 'item_current_rate has no row for an item with no price history yet');
    const { data: valuationBefore } = await clientProduction.from('stock_valuation').select('*').eq('item_id', item.id).single();
    assert(valuationBefore.rate === null, 'stock_valuation.rate is null, not 0, before any rate is set');
    assert(valuationBefore.stock_value === null, 'stock_valuation.stock_value is null, not 0, before any rate is set');

    console.log('\nitem_price_history: purchase/store/admin can record a rate, production cannot...');
    const { error: productionRateErr } = await clientProduction
      .from('item_price_history')
      .insert({ item_id: item.id, rate: 10, effective_date: '2026-01-01', created_by: productionUser.id });
    assert(!!productionRateErr, 'production role cannot record a price history entry');

    const { data: firstRate, error: firstRateErr } = await clientPurchase
      .from('item_price_history')
      .insert({ item_id: item.id, rate: 40, effective_date: '2026-01-01', created_by: purchaseUser.id })
      .select()
      .single();
    assert(!firstRateErr, `purchase role can record a price history entry${firstRateErr ? ` (${firstRateErr.message})` : ''}`);

    console.log('\nitem_current_rate: reflects the one rate recorded so far...');
    const { data: rateAfterFirst } = await clientStore.from('item_current_rate').select('*').eq('item_id', item.id).single();
    assert(Number(rateAfterFirst.rate) === 40, 'item_current_rate.rate is 40');

    console.log('\nA later-dated rate change: store can also record one, and it becomes current WITHOUT erasing the first entry...');
    const { data: secondRate, error: secondRateErr } = await clientStore
      .from('item_price_history')
      .insert({ item_id: item.id, rate: 55, effective_date: '2026-02-01', created_by: storeUser.id })
      .select()
      .single();
    assert(!secondRateErr, `store role can record a second price history entry${secondRateErr ? ` (${secondRateErr.message})` : ''}`);

    const { data: rateAfterSecond } = await admin.from('item_current_rate').select('*').eq('item_id', item.id).single();
    assert(Number(rateAfterSecond.rate) === 55, 'item_current_rate.rate is now 55 (the later effective_date)');

    const { data: fullHistory } = await clientProduction.from('item_price_history').select('*').eq('item_id', item.id).order('effective_date');
    assert((fullHistory ?? []).length === 2, 'both price_history entries still exist — the first was never overwritten');
    assert(Number(fullHistory?.[0]?.rate) === 40 && Number(fullHistory?.[1]?.rate) === 55, 'both the old (40) and new (55) rates are queryable, in order');

    console.log('\nstock_valuation: current_qty (20) x the current rate (55) = 1100, using the resolved current rate, not the older one...');
    const { data: valuationAfter } = await clientPurchase.from('stock_valuation').select('*').eq('item_id', item.id).single();
    assert(Number(valuationAfter.current_qty) === 20, 'stock_valuation.current_qty is 20');
    assert(Number(valuationAfter.rate) === 55, 'stock_valuation.rate resolves to the current (55), not the superseded (40)');
    assert(Number(valuationAfter.stock_value) === 1100, 'stock_valuation.stock_value is 1100 (20 x 55)');

    console.log('\nitem_price_history has no update or delete policy — history cannot be edited or erased...');
    const { error: updateErr } = await clientPurchase.from('item_price_history').update({ rate: 999 }).eq('id', firstRate.id);
    const { data: rowAfterUpdateAttempt } = await admin.from('item_price_history').select('rate').eq('id', firstRate.id).single();
    assert(
      !!updateErr || Number(rowAfterUpdateAttempt.rate) === 40,
      'a direct update to a price history row is rejected (or silently filtered to zero rows by RLS) — the original rate (40) still stands'
    );

    const { error: deleteErr } = await clientPurchase.from('item_price_history').delete().eq('id', secondRate.id);
    const { data: rowAfterDeleteAttempt } = await admin.from('item_price_history').select('id').eq('id', secondRate.id).maybeSingle();
    assert(!!deleteErr || rowAfterDeleteAttempt !== null, 'a direct delete of a price history row is rejected (or silently filtered) — the row still exists');

    console.log('\nstock_statement_for_range: seeding a second item with movements before/inside/after a March 2026 range, and rates before/inside/after it...');
    const { data: rangedItem } = await admin
      .from('items')
      .insert({ name: `RLS Test Ranged Widget ${stamp}`, item_code: 'RLS-CODE-1', item_type: 'RM', source: 'RLS Test Vendor', location: 'Rack Z9' })
      .select()
      .single();
    itemIds.push(rangedItem.id);
    // Opening balance: 20 units in, well before the range.
    await admin
      .from('stock_movements')
      .insert({ item_id: rangedItem.id, movement_type: 'in', quantity: 20, created_by: storeUser.id, created_at: '2020-01-01T00:00:00Z' });
    // Inside the range (1-31 March 2026): 15 in, 5 out.
    await admin
      .from('stock_movements')
      .insert({ item_id: rangedItem.id, movement_type: 'in', quantity: 15, created_by: storeUser.id, created_at: '2026-03-10T00:00:00Z' });
    await admin
      .from('stock_movements')
      .insert({ item_id: rangedItem.id, movement_type: 'out', quantity: 5, created_by: storeUser.id, created_at: '2026-03-20T00:00:00Z' });
    // After the range: should not affect Closing Qty for this range at all.
    await admin
      .from('stock_movements')
      .insert({ item_id: rangedItem.id, movement_type: 'in', quantity: 100, created_by: storeUser.id, created_at: '2026-04-15T00:00:00Z' });
    // Rates: one before the range, one inside it (the one that should win — latest effective_date <= dateTo), one after dateTo (should not apply).
    await admin.from('item_price_history').insert({ item_id: rangedItem.id, rate: 40, effective_date: '2026-02-01', created_by: purchaseUser.id });
    await admin.from('item_price_history').insert({ item_id: rangedItem.id, rate: 55, effective_date: '2026-03-15', created_by: purchaseUser.id });
    await admin.from('item_price_history').insert({ item_id: rangedItem.id, rate: 99, effective_date: '2026-04-01', created_by: purchaseUser.id });

    const { data: statementRows, error: statementErr } = await clientProduction.rpc('stock_statement_for_range', {
      date_from: '2026-03-01',
      date_to: '2026-03-31',
    });
    assert(
      !statementErr,
      `stock_statement_for_range is readable by every authenticated role, including production${statementErr ? ` (${statementErr.message})` : ''}`
    );
    const rangedRow = (statementRows ?? []).find((r) => r.item_id === rangedItem.id);
    assert(!!rangedRow, 'the ranged item appears in the statement');
    assert(
      rangedRow?.item_code === 'RLS-CODE-1' && rangedRow?.item_type === 'RM' && rangedRow?.source === 'RLS Test Vendor' && rangedRow?.location === 'Rack Z9',
      'item_code/item_type/source/location pass through unchanged'
    );
    assert(Number(rangedRow?.opening_qty) === 20, 'opening_qty (20) reflects only movements before dateFrom');
    assert(Number(rangedRow?.inward_qty) === 15, 'inward_qty (15) reflects only "in" movements inside the range');
    assert(Number(rangedRow?.outward_qty) === 5, 'outward_qty (5) reflects only "out" movements inside the range');
    assert(Number(rangedRow?.closing_qty) === 30, 'closing_qty (30) = opening (20) + inward (15) - outward (5), ignoring the after-range movement');
    assert(Number(rangedRow?.rate) === 55, 'rate (55) resolves to whichever was in effect on dateTo, not the earlier (40) or the later, not-yet-effective (99)');
    assert(Number(rangedRow?.stock_value) === 1650, 'stock_value (1650) = closing_qty (30) x the resolved rate (55)');

    console.log('\nstock_statement_for_range: an item with movements in range but no rate on record shows a null rate and stock_value, not zero...');
    const { data: unratedItem } = await admin.from('items').insert({ name: `RLS Test Unrated ${stamp}` }).select().single();
    itemIds.push(unratedItem.id);
    await admin
      .from('stock_movements')
      .insert({ item_id: unratedItem.id, movement_type: 'in', quantity: 8, created_by: storeUser.id, created_at: '2026-03-05T00:00:00Z' });
    const { data: statementRows2 } = await clientProduction.rpc('stock_statement_for_range', { date_from: '2026-03-01', date_to: '2026-03-31' });
    const unratedRow = (statementRows2 ?? []).find((r) => r.item_id === unratedItem.id);
    assert(!!unratedRow && Number(unratedRow.closing_qty) === 8, 'the unrated item still reports its closing_qty (8)');
    assert(unratedRow?.rate === null, 'rate is null, not 0, when no price history exists on or before dateTo');
    assert(unratedRow?.stock_value === null, 'stock_value is null, not 0, when no price history exists on or before dateTo');
  } finally {
    console.log('\nCleaning up test data...');
    await cleanup({ userIds, itemIds });
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

run().catch((err) => {
  console.error('Integration test run failed:', err.message);
  process.exit(1);
});
