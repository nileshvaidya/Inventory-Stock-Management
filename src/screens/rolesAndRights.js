// Roles & Rights (direct request): a role x permission matrix showing
// which of the 6 roles can exercise each of the 7 write-permission
// capability areas, editable by an admin. Admin-only — the screen's own
// guard below is a UX nicety, not the real security boundary: every
// toggle goes through admin_set_role_permission() (supabase/schema.sql),
// which enforces is_admin() itself and rejects touching 'admin' at all
// (see rolePermissions.js/schema.sql for why admin always has every
// right, unconditionally, and can't be edited — the same "can't lock
// yourself out" floor as Users & Roles' own role/status controls).
import { getCurrentProfile } from '../auth.js';
import { renderShell } from '../layout.js';
import { escapeHtml } from '../components.js';
import { createStore } from '../state.js';
import { canViewModule } from '../navPermissions.js';
import { ROLES } from '../roles.js';
import { PERMISSIONS, fetchRolePermissions, setRolePermission, hasPermission } from '../rolePermissions.js';

export async function render(container) {
  const user = await getCurrentProfile();
  if (!user) {
    window.location.hash = '#/login';
    return;
  }
  if (!canViewModule('/roles-and-rights', user.role)) {
    window.location.hash = '#/dashboard';
    return;
  }

  // rolePermissions: [] — not a fetch avoided lazily, a real no-op: this
  // screen's own guard above already restricts it to admin, and admin's
  // sidebar visibility never depends on role_permissions at all (every
  // route admin needs is already in MODULE_ROLES' static list). Passing
  // an explicit empty array here is what stops renderShell from issuing
  // its own redundant fetch for a screen already about to load and
  // display the exact same table's full contents itself, right below.
  const content = await renderShell(container, { activeRoute: '/roles-and-rights', user, rolePermissions: [] });
  content.setAttribute('data-screen', 'roles-and-rights');
  const store = createStore({ rows: [], loading: true, error: false });

  async function load() {
    try {
      const rows = await fetchRolePermissions();
      store.setState({ rows, loading: false, error: false });
    } catch {
      store.setState({ loading: false, error: true });
    }
  }

  function paint() {
    renderContent(content, store.getState());
    wireEvents(content, store, load);
  }

  store.subscribe(paint);
  paint();
  await load();
}

function renderContent(container, state) {
  container.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;flex-wrap:wrap;gap:12px">
      <h1 style="margin:0">Roles & Rights</h1>
    </div>
    <p style="font-size:13px;color:var(--color-neutral-500);margin:0 0 16px;max-width:640px">
      What each role can actually do, beyond just which screens they can see (that's set per-user on
      <a href="#/users" style="color:var(--color-accent)">Users &amp; Roles</a>). Admin always has every
      right and can't be changed here.
    </p>
    <div class="card elev-sm" style="padding:0;overflow-x:auto">
      ${
        state.loading
          ? `<div style="padding:20px;font-size:13px;color:var(--color-neutral-500)">Loading…</div>`
          : state.error
            ? `<div style="padding:20px;text-align:center">
                <p style="font-size:13px;color:var(--color-accent-2-200);margin:0 0 10px">Couldn't load role permissions.</p>
                <button type="button" class="btn btn-secondary" data-action="retry">Retry</button>
              </div>`
            : renderMatrix(state.rows)
      }
    </div>
  `;
}

function renderMatrix(rows) {
  return `
    <table class="table" style="min-width:760px">
      <thead>
        <tr>
          <th style="min-width:220px">Right</th>
          ${ROLES.map((r) => `<th style="text-align:center">${escapeHtml(r.label)}</th>`).join('')}
        </tr>
      </thead>
      <tbody>
        ${PERMISSIONS.map(
          (perm) => `
          <tr data-permission-row="${escapeHtml(perm.key)}">
            <td>
              <div style="font-size:13px;font-weight:600">${escapeHtml(perm.label)}</div>
              <div style="font-size:12px;color:var(--color-neutral-500)">${escapeHtml(perm.description)}</div>
            </td>
            ${ROLES.map((r) => {
              if (r.value === 'admin') {
                return `<td style="text-align:center"><input type="checkbox" checked disabled title="Admin always has every right" /></td>`;
              }
              const granted = hasPermission(rows, r.value, perm.key);
              return `<td style="text-align:center">
                <input
                  type="checkbox"
                  data-action="toggle-permission"
                  data-role="${escapeHtml(r.value)}"
                  data-permission="${escapeHtml(perm.key)}"
                  ${granted ? 'checked' : ''}
                />
              </td>`;
            }).join('')}
          </tr>`
        ).join('')}
      </tbody>
    </table>
  `;
}

function wireEvents(container, store, load) {
  container.querySelector('[data-action="retry"]')?.addEventListener('click', load);

  container.querySelectorAll('[data-action="toggle-permission"]').forEach((checkbox) => {
    checkbox.addEventListener('change', async (e) => {
      const el = /** @type {HTMLInputElement} */ (e.target);
      const role = el.dataset.role;
      const permission = el.dataset.permission;
      const granted = el.checked;
      el.disabled = true;
      try {
        await setRolePermission({ role, permission, granted });
        await load();
      } catch (err) {
        window.alert(err.message || 'Could not update this permission.');
        el.checked = !granted;
        el.disabled = false;
      }
    });
  });
}
