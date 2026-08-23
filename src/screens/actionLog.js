import { makePlaceholderScreen } from '../placeholderScreen.js';

export const render = makePlaceholderScreen({
  route: '/action-log',
  title: 'Action Log',
  phase: 9,
  description: 'A filterable audit trail (username, date range, action type) of every action across the app.',
});
