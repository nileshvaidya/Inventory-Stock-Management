// Dashboard shell. Real KPI cards + activity feed land in Phase 8 (build
// brief's "Suggested Additional Features" sign-off: dashboard KPIs) — this
// is just the authenticated landing page + shell wiring for Phase 0.
import { getCurrentProfile } from '../auth.js';
import { renderShell } from '../layout.js';
import { escapeHtml } from '../components.js';

export async function render(container) {
  const user = await getCurrentProfile();
  if (!user) {
    window.location.hash = '#/login';
    return;
  }

  const content = renderShell(container, { activeRoute: '/dashboard', user });
  content.setAttribute('data-screen', 'dashboard');
  content.innerHTML = `
    <h1 style="margin-bottom:4px">Welcome, ${escapeHtml(user.name)}</h1>
    <p class="text-muted" style="margin-bottom:24px">
      ${user.role ? `Role: ${escapeHtml(user.role)}` : 'No role assigned yet — an Admin will assign one once User &amp; Role Management (Phase 1) ships.'}
    </p>
    <div class="card elev-sm" style="max-width:640px">
      <div class="card-kicker">Phase 0</div>
      <h2 class="card-title">Scaffold, auth, and base shell</h2>
      <p class="card-body">
        This is the Phase 0 landing page. KPI cards and a recent-activity feed
        (reusing the Action Log) are planned for Phase 8, pending your sign-off
        on that scope item.
      </p>
    </div>
  `;
}
