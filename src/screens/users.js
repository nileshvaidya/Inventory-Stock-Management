// Users & Roles (Phase 1). Admin-only: fetchAdminUsers/setUserRole/
// setUserStatus (src/admin.js) all enforce that server-side via is_admin()
// inside their RPCs, so this screen's own guard below is a UX nicety, not
// the real security boundary (P1-3, P1-5).
import { getCurrentProfile } from '../auth.js';
import { renderShell } from '../layout.js';
import { escapeHtml, initials } from '../components.js';
import { createStore } from '../state.js';
import { canViewModule } from '../navPermissions.js';
import { ROLES } from '../roles.js';
import { fetchAdminUsers, setUserRole, setUserStatus } from '../admin.js';
import { open as openAddUserDialog } from '../dialogs/addUserDialog.js';

export async function render(container) {
  const user = await getCurrentProfile();
  if (!user) {
    window.location.hash = '#/login';
    return;
  }
  if (!canViewModule('/users', user.role)) {
    window.location.hash = '#/dashboard';
    return;
  }

  const content = renderShell(container, { activeRoute: '/users', user });
  content.setAttribute('data-screen', 'users');
  const store = createStore({ users: [], loading: true, error: false });

  async function load() {
    try {
      const users = await fetchAdminUsers();
      store.setState({ users, loading: false, error: false });
    } catch {
      store.setState({ loading: false, error: true });
    }
  }

  function paint() {
    renderContent(content, store.getState(), user);
    wireEvents(content, store, user, load);
  }

  store.subscribe(paint);
  paint();
  await load();
}

function renderContent(container, state, viewer) {
  container.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;flex-wrap:wrap;gap:12px">
      <h1 style="margin:0">Users & Roles</h1>
      <button type="button" class="btn btn-primary" data-action="add-user">+ Add User</button>
    </div>
    <div class="card elev-sm" style="padding:0;overflow-x:auto">
      ${
        state.loading
          ? `<div style="padding:20px;font-size:13px;color:var(--color-neutral-500)">Loading…</div>`
          : state.error
            ? `<div style="padding:20px;text-align:center">
                <p style="font-size:13px;color:var(--color-accent-2-200);margin:0 0 10px">Couldn't load users.</p>
                <button type="button" class="btn btn-secondary" data-action="retry">Retry</button>
              </div>`
            : state.users.length === 0
              ? `<div style="padding:20px;font-size:13px;color:var(--color-neutral-500)">No users yet.</div>`
              : `<table class="table" style="min-width:600px">
                  <thead><tr><th>User</th><th>Role</th><th>Status</th><th>Actions</th></tr></thead>
                  <tbody>${state.users.map((u) => renderRow(u, viewer)).join('')}</tbody>
                </table>`
      }
    </div>
  `;
}

function renderRow(u, viewer) {
  const isSelf = u.id === viewer.id;
  return `
    <tr data-user-row="${escapeHtml(u.id)}">
      <td>
        <div style="display:flex;align-items:center;gap:10px">
          <div style="width:30px;height:30px;border-radius:50%;background:var(--color-neutral-800);color:var(--color-neutral-200);display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:600;flex:none">${escapeHtml(initials(u.name))}</div>
          <div>
            <div style="font-size:14px">${escapeHtml(u.name)}${isSelf ? ' <span style="color:var(--color-neutral-500);font-size:12px">(you)</span>' : ''}</div>
            <div style="font-size:12px;color:var(--color-neutral-500)">${escapeHtml(u.email)}</div>
          </div>
        </div>
      </td>
      <td>
        <select class="input" data-action="role-select" data-user-id="${escapeHtml(u.id)}" style="width:180px;padding:6px 8px;font-size:13px" ${isSelf ? 'disabled title="You cannot change your own role."' : ''}>
          <option value="">No role assigned</option>
          ${ROLES.map((r) => `<option value="${escapeHtml(r.value)}" ${u.role === r.value ? 'selected' : ''}>${escapeHtml(r.label)}</option>`).join('')}
        </select>
      </td>
      <td><span class="tag ${u.status === 'active' ? 'tag-accent' : 'tag-neutral'}">${u.status === 'active' ? 'Active' : 'Inactive'}</span></td>
      <td>
        <button type="button" class="btn btn-secondary" data-action="toggle-status" data-user-id="${escapeHtml(u.id)}" style="padding:5px 12px;font-size:12px" ${isSelf ? 'disabled title="You cannot change your own status."' : ''}>
          ${u.status === 'active' ? 'Deactivate' : 'Activate'}
        </button>
      </td>
    </tr>`;
}

function wireEvents(container, store, viewer, load) {
  const addBtn = container.querySelector('[data-action="add-user"]');
  if (addBtn) addBtn.addEventListener('click', () => openAddUserDialog(load));

  const retryBtn = container.querySelector('[data-action="retry"]');
  if (retryBtn) retryBtn.addEventListener('click', () => {
    store.setState({ loading: true, error: false });
    load();
  });

  container.querySelectorAll('[data-action="role-select"]').forEach((select) => {
    select.addEventListener('change', async () => {
      const targetId = select.dataset.userId;
      const newRole = select.value || null;
      try {
        await setUserRole(targetId, newRole);
        await load();
      } catch (err) {
        window.alert(err.message || 'Could not update role.');
        await load();
      }
    });
  });

  container.querySelectorAll('[data-action="toggle-status"]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const targetId = btn.dataset.userId;
      const current = store.getState().users.find((u) => u.id === targetId);
      const newStatus = current?.status === 'active' ? 'inactive' : 'active';
      try {
        await setUserStatus(targetId, newStatus);
        await load();
      } catch (err) {
        window.alert(err.message || 'Could not update status.');
        await load();
      }
    });
  });
}
