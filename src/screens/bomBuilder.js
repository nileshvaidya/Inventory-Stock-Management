import { makePlaceholderScreen } from '../placeholderScreen.js';

export const render = makePlaceholderScreen({
  route: '/bom-builder',
  title: 'BoM Builder',
  phase: 6,
  description: 'Build nested bills of materials (sub-assemblies referencing other BoMs) and record production.',
});
