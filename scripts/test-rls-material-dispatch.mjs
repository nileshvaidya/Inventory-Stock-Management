// RLS/RPC integration tests for Phase 11's material_dispatch /
// material_dispatch_line_items tables and the attach_dispatch_challan_file
// / authorize_material_dispatch / mark_dispatch_payment_received RPCs, run
// against a REAL Supabase project — same pattern and rationale as
// test-rls-work-orders.mjs. In particular this verifies the table has NO
// direct update policy at all (every mutation beyond the initial insert
// goes through its own security-definer RPC) and that authorization is
// atomically blocked when stock is short.
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

async function cleanup({ userIds, dispatchIds, itemIds }) {
  for (const dispatchId of dispatchIds) {
    await admin.from('material_dispatch_line_items').delete().eq('dispatch_id', dispatchId);
    await admin.from('material_dispatch').delete().eq('id', dispatchId);
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
  console.log('Setting up test users (store, admin, production) and a fixture item...');
  const storeUser = await createUser({ name: `RLS Test Store MD ${stamp}`, email: `rls-store-md-${stamp}@example.com`, role: 'store' });
  const adminUser = await createUser({ name: `RLS Test Admin MD ${stamp}`, email: `rls-admin-md-${stamp}@example.com`, role: 'admin' });
  const productionUser = await createUser({ name: `RLS Test Production MD ${stamp}`, email: `rls-production-md-${stamp}@example.com`, role: 'production' });
  const userIds = [storeUser.id, adminUser.id, productionUser.id];

  const itemIds = [];
  const dispatchIds = [];

  try {
    const clientStore = await signedInClient(storeUser.email);
    const clientAdmin = await signedInClient(adminUser.email);
    const clientProduction = await signedInClient(productionUser.email);

    console.log('\nSeeding a fixture item (Gadget) with 100 on hand via the service-role client...');
    const { data: gadget } = await admin.from('items').insert({ name: `RLS Test Gadget MD ${stamp}` }).select().single();
    itemIds.push(gadget.id);
    await admin.from('stock_movements').insert({ item_id: gadget.id, movement_type: 'in', quantity: 100, created_by: adminUser.id });

    console.log('\ncreate a dispatch: store/admin can, production cannot...');
    const { error: productionInsertErr } = await clientProduction.from('material_dispatch').insert({ dispatch_date: '2026-01-15', created_by: productionUser.id });
    assert(!!productionInsertErr, 'production role cannot create a material dispatch record (insert policy is store/admin only)');

    const { data: dispatch, error: dispatchErr } = await clientStore
      .from('material_dispatch')
      .insert({ dispatch_date: '2026-01-15', reference: 'RLS Test', created_by: storeUser.id })
      .select()
      .single();
    assert(!dispatchErr, `store role can create a material dispatch record${dispatchErr ? ` (${dispatchErr.message})` : ''}`);
    if (dispatch) dispatchIds.push(dispatch.id);

    if (!dispatch) {
      assert(false, 'skipped all downstream checks — creating the dispatch record failed, see its message');
    } else {
      const { error: lineItemErr } = await clientStore.from('material_dispatch_line_items').insert({ dispatch_id: dispatch.id, item_id: gadget.id, quantity: 30 });
      assert(!lineItemErr, `store role can add a line item to its dispatch${lineItemErr ? ` (${lineItemErr.message})` : ''}`);

      console.log('\nattach_dispatch_challan_file: store/admin can, production cannot...');
      const { error: productionAttachErr } = await clientProduction.rpc('attach_dispatch_challan_file', {
        target_dispatch_id: dispatch.id,
        file_path_in: `${dispatch.id}/fake.pdf`,
        file_name_in: 'fake.pdf',
      });
      assert(!!productionAttachErr, 'production role cannot attach a challan file');

      const { data: attached, error: attachErr } = await clientStore.rpc('attach_dispatch_challan_file', {
        target_dispatch_id: dispatch.id,
        file_path_in: `${dispatch.id}/challan.pdf`,
        file_name_in: 'challan.pdf',
      });
      assert(!attachErr, `store role can attach a challan file${attachErr ? ` (${attachErr.message})` : ''}`);
      assert(attached?.challan_file_name === 'challan.pdf', 'the attached file name was persisted');

      console.log('\nA direct client update is blocked entirely — no update policy exists on this table...');
      const { error: directUpdateErr } = await clientStore.from('material_dispatch').update({ authorized_at: new Date().toISOString() }).eq('id', dispatch.id);
      const { data: dispatchAfterDirectAttempt } = await admin.from('material_dispatch').select('authorized_at').eq('id', dispatch.id).single();
      assert(
        !!directUpdateErr || dispatchAfterDirectAttempt.authorized_at === null,
        'a direct update cannot forge authorized_at (either rejected outright, or silently filtered to zero rows by RLS)'
      );

      console.log('\nauthorize_material_dispatch: store/production cannot, admin can, and inventory is actually deducted...');
      const { error: storeAuthorizeErr } = await clientStore.rpc('authorize_material_dispatch', { target_dispatch_id: dispatch.id });
      assert(!!storeAuthorizeErr, 'store role cannot authorize a dispatch');
      const { error: productionAuthorizeErr } = await clientProduction.rpc('authorize_material_dispatch', { target_dispatch_id: dispatch.id });
      assert(!!productionAuthorizeErr, 'production role cannot authorize a dispatch');

      const { data: authorized, error: authorizeErr } = await clientAdmin.rpc('authorize_material_dispatch', { target_dispatch_id: dispatch.id });
      assert(!authorizeErr, `admin role can authorize a dispatch${authorizeErr ? ` (${authorizeErr.message})` : ''}`);

      if (authorized) {
        assert(authorized.authorized_at !== null, 'authorized_at was stamped');
        assert(authorized.authorized_by === adminUser.id, 'authorized_by records the authorizing admin');

        const { data: movements } = await admin.from('stock_movements').select('*').eq('reference_type', 'material_dispatch').eq('reference_id', dispatch.id);
        const gadgetOut = (movements ?? []).find((m) => m.item_id === gadget.id && m.movement_type === 'out');
        assert(!!gadgetOut && Number(gadgetOut.quantity) === 30, 'a Gadget "out" movement of 30 was recorded, tagged to this dispatch');

        const { data: gadgetStockAfter } = await admin.from('current_stock').select('current_qty').eq('item_id', gadget.id).single();
        assert(Number(gadgetStockAfter.current_qty) === 70, 'Gadget current_qty actually dropped to 70 (100 - 30)');

        console.log('\nauthorizing an already-authorized dispatch is rejected...');
        const { error: reAuthorizeErr } = await clientAdmin.rpc('authorize_material_dispatch', { target_dispatch_id: dispatch.id });
        assert(!!reAuthorizeErr, 'authorizing a dispatch that is already authorized fails');

        console.log('\nmark_dispatch_payment_received: store/production cannot, admin can...');
        const { error: storePaymentErr } = await clientStore.rpc('mark_dispatch_payment_received', { target_dispatch_id: dispatch.id });
        assert(!!storePaymentErr, 'store role cannot mark payment received');
        const { error: productionPaymentErr } = await clientProduction.rpc('mark_dispatch_payment_received', { target_dispatch_id: dispatch.id });
        assert(!!productionPaymentErr, 'production role cannot mark payment received');

        const { data: paid, error: paymentErr } = await clientAdmin.rpc('mark_dispatch_payment_received', { target_dispatch_id: dispatch.id });
        assert(!paymentErr, `admin role can mark payment received${paymentErr ? ` (${paymentErr.message})` : ''}`);
        if (paid) {
          assert(paid.payment_received_at !== null, 'payment_received_at was stamped');
          assert(paid.payment_received_by === adminUser.id, 'payment_received_by records the admin');
        }

        console.log('\nmarking payment received a second time is rejected...');
        const { error: rePaymentErr } = await clientAdmin.rpc('mark_dispatch_payment_received', { target_dispatch_id: dispatch.id });
        assert(!!rePaymentErr, 'marking payment received twice fails');
      } else {
        assert(false, 'skipped all post-authorization checks — the authorize call above failed, see its message');
      }
    }

    console.log('\nmark_dispatch_payment_received on a never-authorized dispatch is rejected...');
    const { data: unauthorizedDispatch } = await clientStore
      .from('material_dispatch')
      .insert({ dispatch_date: '2026-01-16', created_by: storeUser.id })
      .select()
      .single();
    if (unauthorizedDispatch) dispatchIds.push(unauthorizedDispatch.id);
    const { error: paymentBeforeAuthorizeErr } = await clientAdmin.rpc('mark_dispatch_payment_received', { target_dispatch_id: unauthorizedDispatch?.id });
    assert(!!paymentBeforeAuthorizeErr, 'cannot mark payment received before the dispatch is authorized');

    console.log('\nauthorize_material_dispatch is blocked all-or-nothing when a line item is short on stock...');
    const { data: shortfallDispatch } = await clientStore
      .from('material_dispatch')
      .insert({ dispatch_date: '2026-01-16', created_by: storeUser.id })
      .select()
      .single();
    if (shortfallDispatch) {
      dispatchIds.push(shortfallDispatch.id);
      await clientStore.from('material_dispatch_line_items').insert({ dispatch_id: shortfallDispatch.id, item_id: gadget.id, quantity: 9999 });
      const { error: shortfallErr } = await clientAdmin.rpc('authorize_material_dispatch', { target_dispatch_id: shortfallDispatch.id });
      assert(!!shortfallErr, 'authorizing a dispatch whose line item exceeds on-hand stock is rejected');

      const { data: shortfallDispatchAfter } = await admin.from('material_dispatch').select('authorized_at').eq('id', shortfallDispatch.id).single();
      assert(shortfallDispatchAfter.authorized_at === null, 'the blocked dispatch was never marked authorized (nothing written on failure)');

      const { data: gadgetStockUnchanged } = await admin.from('current_stock').select('current_qty').eq('item_id', gadget.id).single();
      assert(Number(gadgetStockUnchanged.current_qty) === 70, "Gadget current_qty is unchanged at 70 — the blocked dispatch's shortage moved nothing");
    } else {
      assert(false, 'skipped shortfall-block checks — creating the shortfall dispatch failed');
    }
  } finally {
    console.log('\nCleaning up test data...');
    await cleanup({ userIds, dispatchIds, itemIds });
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

run().catch((err) => {
  console.error('Integration test run failed:', err.message);
  process.exit(1);
});
