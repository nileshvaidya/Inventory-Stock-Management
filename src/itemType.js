// Shared Item Type metadata (Phase 12 addendum) — used by the New Item
// form (validation.js/Inventory) and the Stock Statement's "Category (RM/
// WIP/FG)" column, matching the reference report's own three-value
// classification. Distinct from items.category, an unrelated free-text
// product grouping already used elsewhere (see supabase/schema.sql's
// comment on the item_type column for why these are two separate fields).
export const ITEM_TYPES = ['RM', 'WIP', 'FG'];

const LABELS = {
  RM: 'Raw Material',
  WIP: 'Work In Progress',
  FG: 'Finished Goods',
};

export function itemTypeLabel(itemType) {
  return LABELS[itemType] ?? itemType;
}
