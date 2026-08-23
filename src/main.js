// Import order matters: Tailwind's reset first, then the Nocturne
// tokens/components on top of it, then Tailwind's component/utility layers
// last so a utility class can still override either. See
// design-reference/README.md and the WorkSync/Task Management scaffold
// this convention is ported from.
import './styles/tailwind-base.css';
import './styles/nocturne.css';
import './styles/tailwind-components-utilities.css';
import { startRouter } from './router.js';

const app = document.getElementById('app');
startRouter(app);
