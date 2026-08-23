import { makePlaceholderScreen } from '../placeholderScreen.js';

export const render = makePlaceholderScreen({
  route: '/po-upload',
  title: 'PO Upload',
  phase: 2,
  description: 'Upload an approved PO PDF; items, quantity, and rate will be parsed here for review before saving.',
});
