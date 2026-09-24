// RLS/RPC integration tests for Phase 11's material_dispatch /
// material_dispatch_line_items tables and the attach_dispatch_challan_file
// / authorize_material_dispatch / mark_dispatch_payment_received RPCs, run
// against a REAL Supabase project — same pattern and rationale as
// test-rls-work-orders.mjs. In particular this verifies the table has NO
// direct update policy at all (every mutation beyond the initial insert
// goes through its own security-definer RPC) and that authorization is
// atomically blocked when stock is short.
//
// Phase 13 addendum: also covers that client_po_number can only ever be
// set by admin (even at insert time), admin_update_dispatch_billing being
// admin-only, and mark_dispatch_payment_received's new payment_date_in
// argument.
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

    console.log('\nclient_po_number is admin-only, even at insert time...');
    const { error: storeInsertWithPoErr } = await clientStore
      .from('material_dispatch')
      .insert({ dispatch_date: '2026-01-15', reference: 'RLS Test', client_po_number: 'PO-NOT-ALLOWED', created_by: storeUser.id });
    assert(!!storeInsertWithPoErr, 'store role cannot set client_po_number, even on its own insert');

    const { data: dispatch, error: dispatchErr } = await clientStore
      .from('material_dispatch')
      .insert({ dispatch_date: '2026-01-15', dc_number: 'DC-RLS-1', reference: 'RLS Test', created_by: storeUser.id })
      .select()
      .single();
    assert(!dispatchErr, `store role can create a material dispatch record${dispatchErr ? ` (${dispatchErr.message})` : ''}`);
    if (dispatch) dispatchIds.push(dispatch.id);

    if (!dispatch) {
      assert(false, 'skipped all downstream checks — creating the dispatch record failed, see its message');
    } else {
      const { error: lineItemErr } = await clientStore.from('material_dispatch_line_items').insert({ dispatch_id: dispatch.id, item_id: gadget.id, quantity: 30, rate: 12.5 });
      assert(!lineItemErr, `store role can add a line item to its dispatch${lineItemErr ? ` (${lineItemErr.message})` : ''}`);

      console.log('\nadmin_update_dispatch_billing: store/production cannot, admin can (on the store-created dispatch)...');
      const { error: storeBillingErr } = await clientStore.rpc('admin_update_dispatch_billing', {
        target_dispatch_id: dispatch.id,
        po_number_in: 'PO-NOT-ALLOWED',
        invoice_number_in: null,
      });
      assert(!!storeBillingErr, 'store role cannot call admin_update_dispatch_billing');
      const { error: productionBillingErr } = await clientProduction.rpc('admin_update_dispatch_billing', {
        target_dispatch_id: dispatch.id,
        po_number_in: 'PO-NOT-ALLOWED',
        invoice_number_in: null,
      });
      assert(!!productionBillingErr, 'production role cannot call admin_update_dispatch_billing');

      const { data: billed, error: billingErr } = await clientAdmin.rpc('admin_update_dispatch_billing', {
        target_dispatch_id: dispatch.id,
        po_number_in: 'PO-CLIENT-RLS',
        invoice_number_in: 'INV-RLS-1',
      });
      assert(!billingErr, `admin role can call admin_update_dispatch_billing${billingErr ? ` (${billingErr.message})` : ''}`);
      if (billed) {
        assert(billed.client_po_number === 'PO-CLIENT-RLS', 'client_po_number was set by admin_update_dispatch_billing');
        assert(billed.our_invoice_number === 'INV-RLS-1', 'our_invoice_number was set by admin_update_dispatch_billing');
      }

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

      console.log('\nupdate_material_dispatch (double-click to edit, before authorization): production cannot, store/admin can, client_po_number stays admin-only...');
      const { error: productionEditErr } = await clientProduction.rpc('update_material_dispatch', {
        target_dispatch_id: dispatch.id,
        dispatch_date_in: '2026-01-15',
        dc_number_in: 'DC-RLS-1',
        reference_in: 'RLS Test',
        our_invoice_number_in: null,
        client_po_number_in: null,
        gst_percent_in: 18,
        notes_in: null,
        line_items_in: [{ item_id: gadget.id, quantity: 30, rate: 12.5 }],
      });
      assert(!!productionEditErr, 'production role cannot call update_material_dispatch');

      const { data: storeEdited, error: storeEditErr } = await clientStore.rpc('update_material_dispatch', {
        target_dispatch_id: dispatch.id,
        dispatch_date_in: '2026-01-17',
        dc_number_in: 'DC-RLS-1-REV',
        reference_in: 'RLS Test (revised)',
        our_invoice_number_in: 'INV-RLS-EDIT',
        client_po_number_in: 'PO-NOT-ALLOWED', // store — should be ignored, not applied
        gst_percent_in: 12,
        notes_in: 'edited by store',
        line_items_in: [{ item_id: gadget.id, quantity: 45, rate: 15 }],
      });
      assert(!storeEditErr, `store role can edit its own unauthorized dispatch${storeEditErr ? ` (${storeEditErr.message})` : ''}`);
      if (storeEdited) {
        assert(storeEdited.dc_number === 'DC-RLS-1-REV', "the dispatch's dc_number was updated");
        assert(storeEdited.dispatch_date === '2026-01-17', "the dispatch's dispatch_date was updated");
        assert(Number(storeEdited.gst_percent) === 12, "the dispatch's gst_percent was updated");
        assert(storeEdited.client_po_number === 'PO-CLIENT-RLS', 'a non-admin edit cannot change client_po_number, even by sending one — it keeps the value admin_update_dispatch_billing set earlier');
      }
      const { data: lineItemsAfterStoreEdit } = await admin.from('material_dispatch_line_items').select('quantity, rate').eq('dispatch_id', dispatch.id);
      assert(
        (lineItemsAfterStoreEdit ?? []).length === 1 && Number(lineItemsAfterStoreEdit[0].quantity) === 45,
        "the line item's quantity was replaced (45), not appended alongside the old one"
      );

      const { data: adminEdited, error: adminEditErr } = await clientAdmin.rpc('update_material_dispatch', {
        target_dispatch_id: dispatch.id,
        dispatch_date_in: '2026-01-17',
        dc_number_in: 'DC-RLS-1-REV',
        reference_in: 'RLS Test (revised)',
        our_invoice_number_in: 'INV-RLS-EDIT',
        client_po_number_in: 'PO-CLIENT-EDIT',
        gst_percent_in: 12,
        notes_in: 'edited by admin',
        // Restored to the original quantity (30) — the authorization
        // assertions further below expect exactly that much deducted.
        line_items_in: [{ item_id: gadget.id, quantity: 30, rate: 12.5 }],
      });
      assert(!adminEditErr, `admin role can edit an unauthorized dispatch${adminEditErr ? ` (${adminEditErr.message})` : ''}`);
      assert(adminEdited?.client_po_number === 'PO-CLIENT-EDIT', 'admin can set client_po_number via update_material_dispatch');

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

        const editPayload = (quantity) => ({
          target_dispatch_id: dispatch.id,
          dispatch_date_in: '2026-01-17',
          dc_number_in: 'DC-RLS-1-REV',
          reference_in: 'RLS Test (revised)',
          our_invoice_number_in: 'INV-RLS-EDIT',
          client_po_number_in: 'PO-CLIENT-EDIT',
          gst_percent_in: 12,
          notes_in: 'edited after authorization',
          line_items_in: [{ item_id: gadget.id, quantity, rate: 12.5 }],
        });

        console.log('\nupdate_material_dispatch on an authorized dispatch: store/production cannot (admin only from this point on)...');
        const { error: storeEditAfterAuthorizeErr } = await clientStore.rpc('update_material_dispatch', editPayload(30));
        assert(!!storeEditAfterAuthorizeErr, 'store role cannot edit an already-authorized dispatch');
        const { error: productionEditAfterAuthorizeErr } = await clientProduction.rpc('update_material_dispatch', editPayload(30));
        assert(!!productionEditAfterAuthorizeErr, 'production role cannot edit an already-authorized dispatch');

        console.log('\nadmin can edit an authorized dispatch: increasing quantity records an additional "out" movement for just the delta...');
        const { error: increaseErr } = await clientAdmin.rpc('update_material_dispatch', editPayload(50)); // 30 -> 50, delta +20
        assert(!increaseErr, `admin can increase quantity on an authorized dispatch${increaseErr ? ` (${increaseErr.message})` : ''}`);
        const { data: stockAfterIncrease } = await admin.from('current_stock').select('current_qty').eq('item_id', gadget.id).single();
        assert(Number(stockAfterIncrease.current_qty) === 50, 'Gadget current_qty dropped by exactly the +20 delta, to 50 (not re-deducting the full new quantity)');

        console.log('\nadmin can edit an authorized dispatch: decreasing quantity gives stock back via an "in" movement for the delta...');
        const { error: decreaseErr } = await clientAdmin.rpc('update_material_dispatch', editPayload(10)); // 50 -> 10, delta -40
        assert(!decreaseErr, `admin can decrease quantity on an authorized dispatch${decreaseErr ? ` (${decreaseErr.message})` : ''}`);
        const { data: stockAfterDecrease } = await admin.from('current_stock').select('current_qty').eq('item_id', gadget.id).single();
        assert(Number(stockAfterDecrease.current_qty) === 90, 'Gadget current_qty rose by exactly the 40 given back, to 90');

        console.log('\nediting an authorized dispatch is blocked, all-or-nothing, if the increase exceeds available stock...');
        const { error: shortfallEditErr } = await clientAdmin.rpc('update_material_dispatch', editPayload(200)); // 10 -> 200, delta +190, only 90 available
        assert(!!shortfallEditErr, 'increasing a line item beyond available stock on an authorized dispatch is rejected');
        const { data: lineItemsAfterBlockedEdit } = await admin.from('material_dispatch_line_items').select('quantity').eq('dispatch_id', dispatch.id).single();
        assert(Number(lineItemsAfterBlockedEdit.quantity) === 10, "the line item's quantity is unchanged after the blocked edit (still 10)");
        const { data: stockAfterBlockedEdit } = await admin.from('current_stock').select('current_qty').eq('item_id', gadget.id).single();
        assert(Number(stockAfterBlockedEdit.current_qty) === 90, 'Gadget current_qty is unchanged at 90 — the blocked edit moved nothing');

        console.log('\nrestoring the original quantity (10 -> 30) for the assertions further below...');
        const { error: restoreErr } = await clientAdmin.rpc('update_material_dispatch', editPayload(30));
        assert(!restoreErr, `admin can restore the original quantity${restoreErr ? ` (${restoreErr.message})` : ''}`);
        const { data: stockAfterRestore } = await admin.from('current_stock').select('current_qty').eq('item_id', gadget.id).single();
        assert(Number(stockAfterRestore.current_qty) === 70, 'Gadget current_qty is back to 70 after restoring the original quantity');

        console.log('\nauthorizing an already-authorized dispatch is rejected...');
        const { error: reAuthorizeErr } = await clientAdmin.rpc('authorize_material_dispatch', { target_dispatch_id: dispatch.id });
        assert(!!reAuthorizeErr, 'authorizing a dispatch that is already authorized fails');

        console.log('\nmark_dispatch_payment_received: store/production cannot, admin can, and requires a payment date...');
        const { error: storePaymentErr } = await clientStore.rpc('mark_dispatch_payment_received', { target_dispatch_id: dispatch.id, payment_date_in: '2026-01-20' });
        assert(!!storePaymentErr, 'store role cannot mark payment received');
        const { error: productionPaymentErr } = await clientProduction.rpc('mark_dispatch_payment_received', { target_dispatch_id: dispatch.id, payment_date_in: '2026-01-20' });
        assert(!!productionPaymentErr, 'production role cannot mark payment received');

        const { error: noDateErr } = await clientAdmin.rpc('mark_dispatch_payment_received', { target_dispatch_id: dispatch.id, payment_date_in: null });
        assert(!!noDateErr, 'admin role cannot mark payment received without a payment date');

        const { data: paid, error: paymentErr } = await clientAdmin.rpc('mark_dispatch_payment_received', { target_dispatch_id: dispatch.id, payment_date_in: '2026-01-20' });
        assert(!paymentErr, `admin role can mark payment received${paymentErr ? ` (${paymentErr.message})` : ''}`);
        if (paid) {
          assert(paid.payment_received_at !== null, 'payment_received_at was stamped');
          assert(paid.payment_received_by === adminUser.id, 'payment_received_by records the admin');
          assert(paid.payment_date === '2026-01-20', 'payment_date records the date the admin entered');
        }

        console.log('\nmarking payment received a second time is rejected...');
        const { error: rePaymentErr } = await clientAdmin.rpc('mark_dispatch_payment_received', { target_dispatch_id: dispatch.id, payment_date_in: '2026-01-21' });
        assert(!!rePaymentErr, 'marking payment received twice fails');

        console.log('\nrevert_dispatch_payment: store/production cannot, admin can, and it clears the payment columns...');
        const { error: storeRevertErr } = await clientStore.rpc('revert_dispatch_payment', { target_dispatch_id: dispatch.id });
        assert(!!storeRevertErr, 'store role cannot revert payment status');
        const { error: productionRevertErr } = await clientProduction.rpc('revert_dispatch_payment', { target_dispatch_id: dispatch.id });
        assert(!!productionRevertErr, 'production role cannot revert payment status');

        const { data: reverted, error: revertErr } = await clientAdmin.rpc('revert_dispatch_payment', { target_dispatch_id: dispatch.id });
        assert(!revertErr, `admin role can revert payment status${revertErr ? ` (${revertErr.message})` : ''}`);
        if (reverted) {
          assert(reverted.payment_received_at === null, 'payment_received_at was cleared');
          assert(reverted.payment_received_by === null, 'payment_received_by was cleared');
          assert(reverted.payment_date === null, 'payment_date was cleared');
        }

        console.log('\nreverting a dispatch that is not marked Paid is rejected...');
        const { error: revertNotPaidErr } = await clientAdmin.rpc('revert_dispatch_payment', { target_dispatch_id: dispatch.id });
        assert(!!revertNotPaidErr, 'reverting an already-Pending dispatch fails');

        console.log('\nthe dispatch can be marked paid again after a revert (full cycle)...');
        const { data: paidAgain, error: paidAgainErr } = await clientAdmin.rpc('mark_dispatch_payment_received', { target_dispatch_id: dispatch.id, payment_date_in: '2026-01-22' });
        assert(!paidAgainErr, `admin role can mark payment received again after a revert${paidAgainErr ? ` (${paidAgainErr.message})` : ''}`);
        if (paidAgain) {
          assert(paidAgain.payment_date === '2026-01-22', 'the re-marked payment_date is the new date, not the original');
        }
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
    const { error: paymentBeforeAuthorizeErr } = await clientAdmin.rpc('mark_dispatch_payment_received', {
      target_dispatch_id: unauthorizedDispatch?.id,
      payment_date_in: '2026-01-20',
    });
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
