// Per-vendor field-mapping templates (src/docMapping.js) — lets a manually
// mapped PDF/text layout be reused automatically on future uploads from
// the same vendor, instead of remapping every time. Company-wide read (any
// purchase/admin uploader benefits from a teammate's earlier mapping),
// admin/purchase-only write, same split as vendors.js/projects.js.
import { supabase } from './api.js';

/**
 * @param {string} docType
 * @param {string} vendorId
 * @param {any} [client]
 * @returns {Promise<object|null>} the saved template, or null if none exists yet
 */
export async function fetchMappingForVendor(docType, vendorId, client = supabase) {
  if (!client || !vendorId) return null;
  const { data, error } = await client
    .from('import_field_mappings')
    .select('template')
    .eq('doc_type', docType)
    .eq('vendor_id', vendorId)
    .maybeSingle();
  if (error) throw error;
  return data?.template ?? null;
}

/**
 * @param {string} docType
 * @param {string} vendorId
 * @param {object} template
 * @param {string} createdBy
 * @param {any} [client]
 */
export async function saveMappingForVendor(docType, vendorId, template, createdBy, client = supabase) {
  if (!client) throw new Error('Supabase is not configured.');
  const { error } = await client
    .from('import_field_mappings')
    .upsert(
      { doc_type: docType, vendor_id: vendorId, template, created_by: createdBy, updated_at: new Date().toISOString() },
      { onConflict: 'doc_type,vendor_id' }
    );
  if (error) throw error;
}
