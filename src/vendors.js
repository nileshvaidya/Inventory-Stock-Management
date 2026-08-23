// Vendor Master data layer (Phase 2's "suggested additional feature",
// confirmed in scope) — company-wide read, admin/purchase-only write via
// RLS, same split as projects.js.
import { supabase } from './api.js';

/** @param {any} [client] */
export async function fetchVendors(client = supabase) {
  if (!client) return [];
  const { data, error } = await client.from('vendors').select('*').is('deleted_at', null).order('name');
  if (error) throw error;
  return data;
}

/**
 * @param {{ name: string, gstin?: string|null, contact?: string|null, defaultPaymentTermsDays?: number|null }} form
 * @param {any} [client]
 */
export async function createVendor(form, client = supabase) {
  if (!client) throw new Error('Supabase is not configured.');
  const { data, error } = await client
    .from('vendors')
    .insert({
      name: form.name,
      gstin: form.gstin || null,
      contact: form.contact || null,
      default_payment_terms_days: form.defaultPaymentTermsDays ?? null,
    })
    .select()
    .single();
  if (error) throw error;
  return data;
}
