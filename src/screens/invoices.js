import { makePlaceholderScreen } from '../placeholderScreen.js';

export const render = makePlaceholderScreen({
  route: '/invoices',
  title: 'Invoices',
  phase: 5,
  description: 'Link invoices to one or more POs, track payment terms/due dates, and overdue status.',
});
