import { makePlaceholderScreen } from '../placeholderScreen.js';

export const render = makePlaceholderScreen({
  route: '/order-status',
  title: 'Order Status',
  phase: 2,
  description: 'Every PO, filterable by date, project/order, and status.',
});
