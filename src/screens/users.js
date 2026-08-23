import { makePlaceholderScreen } from '../placeholderScreen.js';

export const render = makePlaceholderScreen({
  route: '/users',
  title: 'Users & Roles',
  phase: 1,
  description: 'Admin user list, invite/create, role assignment, and activate/deactivate.',
});
