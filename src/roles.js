// The confirmed Phase 1 role list — must stay in sync by hand with
// supabase/schema.sql's users_role_check constraint. `value` is what's
// actually stored in `users.role` and checked everywhere in app code
// (e.g. src/layout.js, src/screens/billPayments.js check for 'authorized'
// literally); `label` is what the UI shows.
export const ROLES = [
  { value: 'admin', label: 'Admin' },
  { value: 'purchase', label: 'Purchase' },
  { value: 'store', label: 'Store/Warehouse' },
  { value: 'inspector', label: 'Inspector' },
  { value: 'authorized', label: 'Accounts/Authorized' },
  { value: 'production', label: 'Production' },
];

export const ROLE_VALUES = ROLES.map((r) => r.value);

export function roleLabel(value) {
  return ROLES.find((r) => r.value === value)?.label ?? 'No role assigned';
}
