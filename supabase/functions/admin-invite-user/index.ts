// Admin "Add User" (Phase 1). Uses the Auth Admin API
// (auth.admin.inviteUserByEmail), which only ever works with the
// service-role key — so it can't run client-side — and only runs if the
// caller is themselves an active admin, checked via the same is_admin()
// RPC the rest of Phase 1's RLS relies on. Ported from the
// Task_Management/WorkSync scaffold's admin-invite-user function, adapted
// for this app's role list instead of manager/employee.
import { createClient } from 'npm:@supabase/supabase-js@2';

const ROLES = ['admin', 'purchase', 'store', 'inspector', 'authorized', 'production'];

// The browser calls this function directly (not proxied through Vercel),
// so it's a cross-origin request from the app's own domain — the browser
// sends a preflight OPTIONS request first, and without these headers on
// every response (including the OPTIONS one) it never even reaches the
// POST handling below. This is what the Supabase client's "Failed to send
// a request to the Edge Function" actually means in practice.
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

  // Client scoped to the caller's own JWT — used only to verify who's
  // calling and that they're an active admin, via the RLS-safe is_admin()
  // RPC. Never used to perform the privileged actions below.
  const callerClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: caller } = await callerClient.auth.getUser();
  if (!caller?.user) {
    return new Response(JSON.stringify({ error: 'Not authenticated.' }), {
      status: 401,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const { data: isAdmin } = await callerClient.rpc('is_admin', { uid: caller.user.id });
  if (!isAdmin) {
    return new Response(JSON.stringify({ error: 'Only an admin can invite users.' }), {
      status: 403,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const { name, email, role } = await req.json();
  if (!name || !String(name).trim()) {
    return new Response(JSON.stringify({ error: 'Name is required.' }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
  if (!email || !String(email).trim()) {
    return new Response(JSON.stringify({ error: 'Email is required.' }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
  if (role !== null && !ROLES.includes(role)) {
    return new Response(JSON.stringify({ error: `Invalid role: ${role}` }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  // Service-role client for the two privileged steps below — creating the
  // auth user and inserting their profile row bypasses RLS entirely, which
  // is why this whole flow has to run server-side.
  const adminClient = createClient(supabaseUrl, serviceRoleKey);

  const { data: invited, error: inviteError } = await adminClient.auth.admin.inviteUserByEmail(email);
  if (inviteError) {
    return new Response(JSON.stringify({ error: inviteError.message }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const { error: profileError } = await adminClient.from('users').insert({
    id: invited.user.id,
    name,
    email,
    role,
    status: 'active',
  });
  if (profileError) {
    return new Response(JSON.stringify({ error: profileError.message }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  return new Response(JSON.stringify({ id: invited.user.id }), {
    status: 200,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
});
