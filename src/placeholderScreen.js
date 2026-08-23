// Factory for Phase 0's "coming soon" module screens (build brief: "empty
// placeholder pages for every module in the sidebar"). Each screens/*.js
// file below calls this once with its own title/phase/description; the
// file itself is what that module's real Phase N build replaces render()
// in, so the route/import wiring in router.js never has to change.
import { getCurrentProfile } from './auth.js';
import { renderShell } from './layout.js';
import { escapeHtml } from './components.js';

/**
 * @param {{ route: string, title: string, phase: number, description: string }} opts
 */
export function makePlaceholderScreen({ route, title, phase, description }) {
  return async function render(container) {
    const user = await getCurrentProfile();
    if (!user) {
      window.location.hash = '#/login';
      return;
    }

    const content = renderShell(container, { activeRoute: route, user });
    content.setAttribute('data-screen', route.replace('/', ''));
    content.innerHTML = `
      <div class="card elev-sm" style="max-width:560px">
        <div class="card-kicker">Phase ${phase} — not built yet</div>
        <h2 class="card-title">${escapeHtml(title)}</h2>
        <p class="card-body">${escapeHtml(description)}</p>
      </div>`;
  };
}
