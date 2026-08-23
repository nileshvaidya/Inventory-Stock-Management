import { makePlaceholderScreen } from '../placeholderScreen.js';

export const render = makePlaceholderScreen({
  route: '/inventory',
  title: 'Inventory',
  phase: 4,
  description: 'Current stock by item, filterable by name/category/below-reorder, with a per-item movement ledger.',
});
