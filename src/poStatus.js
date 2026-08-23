// Shared PO status metadata — used by Order Status (Phase 2) now, and by
// Material Inward/Inspection/Master Material Status (Phase 3) once those
// screens are built, since they all display the same purchase_orders.status
// values defined in supabase/schema.sql.
export const PO_STATUSES = ['to_be_received', 'partially_received', 'material_received', 'received_inspected', 'rejected'];

const LABELS = {
  to_be_received: 'To Be Received',
  partially_received: 'Partially Received',
  material_received: 'Material Received',
  received_inspected: 'Received & Inspected',
  rejected: 'Rejected',
};

const TAG_CLASSES = {
  to_be_received: 'tag-neutral',
  partially_received: 'tag-outline',
  material_received: 'tag-outline',
  received_inspected: 'tag-accent',
  rejected: 'tag-accent-2',
};

export function poStatusLabel(status) {
  return LABELS[status] ?? status;
}

export function poStatusTagClass(status) {
  return TAG_CLASSES[status] ?? 'tag-neutral';
}
