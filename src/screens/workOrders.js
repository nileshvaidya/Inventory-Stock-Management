import { makePlaceholderScreen } from '../placeholderScreen.js';

export const render = makePlaceholderScreen({
  route: '/work-orders',
  title: 'Work Orders',
  phase: 7,
  description: 'Create work orders, explode nested BoMs to check availability, and reserve component stock.',
});
