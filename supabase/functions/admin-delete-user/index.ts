// Admin "Delete" on Users & Roles (Phase 1 addendum). Deleting a user is
// mostly a plain Postgres RPC (soft_delete_user — see supabase/schema.sql
// for why this is a soft delete, not a real one: nearly every table's
// created_by/approved_by references public.users with no ON DELETE
// action, so a true delete would fail outright for any real, used
// account). But that RPC only ever touches public.users — the deleted
// user's Supabase Auth account, and the email address on it, are left
// exactly as they were. In practice that meant the "freed up" email could
// never actually be reused: auth.admin.inviteUserByEmail rejects an email
// still registered to any auth.users row, deleted or not. Freeing it
// requires the Auth Admin API (auth.admin.updateUserById), which only
// ever works with the service-role key — same reason admin-invite-user
// has to be an Edge Function instead of a plain RPC.
//
// This function still runs the real admin_delete_user work
// (admin-only + no-self-delete) through the existing soft_delete_user()
// RPC, using a client scoped to the CALLER's own JWT — so is_admin()'s
// auth.uid() resolves correctly and that RPC's own guard logic is the
// single source of truth, not duplicated here. Only the new step (freeing
// the email) needs the service-role client.
import { createClient } from 'npm:@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const authHeader = req.headers.get('Authorization') || '';
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

  const { targetId } = await req.json();
  if (!targetId || !String(targetId).trim()) {
    return new Response(JSON.stringify({ error: 'targetId is required.' }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  // Scoped to the caller's own JWT — soft_delete_user() itself enforces
  // is_admin() and the no-self-delete guard, exactly as it does when
  // called directly from the client for any other purpose.
  const callerClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
  });
  const { error: rpcError } = await callerClient.rpc('soft_delete_user', { target_id: targetId });
  if (rpcError) {
    return new Response(JSON.stringify({ error: rpcError.message }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  // Frees the real email for reuse: a placeholder under the RFC 2606
  // reserved .invalid TLD, unique per user by construction (their own
  // id), so it can never collide with a future real address. Mirrored
  // into public.users.email too so that table's own unique constraint is
  // freed as well — soft_delete_user() doesn't touch email, only
  // deleted_at/status.
  const placeholderEmail = `deleted+${targetId}@deleted.invalid`;
  const adminClient = createClient(supabaseUrl, serviceRoleKey);

  const { error: authUpdateError } = await adminClient.auth.admin.updateUserById(targetId, { email: placeholderEmail });
  if (authUpdateError) {
    return new Response(JSON.stringify({ error: authUpdateError.message }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const { error: profileUpdateError } = await adminClient.from('users').update({ email: placeholderEmail }).eq('id', targetId);
  if (profileUpdateError) {
    return new Response(JSON.stringify({ error: profileUpdateError.message }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
});
