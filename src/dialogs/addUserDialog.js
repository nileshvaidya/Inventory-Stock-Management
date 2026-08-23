// "Add User" dialog (Phase 1). Mounts into #dialog-root, same pattern as
// the Task_Management/WorkSync scaffold's dialogs — created fresh on
// open() and torn down on close/submit rather than kept in the DOM.
import { escapeHtml } from '../components.js';
import { validateInviteUserForm } from '../validation.js';
import { ROLES } from '../roles.js';
import { inviteUser } from '../admin.js';

/**
 * @param {() => void} onInvited called after a successful invite, so the
 *   caller (users.js) can refresh its list.
 */
export function open(onInvited) {
  const root = document.getElementById('dialog-root');
  const el = document.createElement('div');
  el.className = 'dialog-backdrop';
  el.innerHTML = `
    <div class="dialog" role="dialog" aria-modal="true" aria-labelledby="add-user-title">
      <div class="dialog-title" id="add-user-title">Add User</div>
      <p data-role="error" class="hidden" style="font-size:13px;color:var(--color-accent-2-200);background:var(--color-accent-2-900);border:1px solid var(--color-accent-2-700);border-radius:var(--radius-md);padding:8px 12px"></p>
      <form data-form="add-user" id="add-user-form" class="space-y-3">
        <div class="field"><label for="add-user-name">Name</label>
          <input class="input" id="add-user-name" name="name" type="text" required autocomplete="off" />
        </div>
        <div class="field"><label for="add-user-email">Email</label>
          <input class="input" id="add-user-email" name="email" type="email" required autocomplete="off" />
        </div>
        <div class="field"><label for="add-user-role">Role</label>
          <select class="input" id="add-user-role" name="role">
            <option value="">No role yet (assign later)</option>
            ${ROLES.map((r) => `<option value="${escapeHtml(r.value)}">${escapeHtml(r.label)}</option>`).join('')}
          </select>
        </div>
      </form>
      <div class="dialog-actions">
        <button type="button" class="btn btn-secondary" data-action="cancel">Cancel</button>
        <button type="submit" form="add-user-form" class="btn btn-primary" data-action="submit">Send Invite</button>
      </div>
    </div>
  `;
  root.appendChild(el);

  const form = /** @type {HTMLFormElement} */ (el.querySelector('[data-form="add-user"]'));
  const errorEl = el.querySelector('[data-role="error"]');
  const submitBtn = /** @type {HTMLButtonElement} */ (el.querySelector('[data-action="submit"]'));

  function close() {
    el.remove();
  }

  el.querySelector('[data-action="cancel"]').addEventListener('click', close);
  el.addEventListener('click', (e) => {
    if (e.target === el) close();
  });

  async function submit() {
    errorEl.classList.add('hidden');
    const values = {
      name: /** @type {HTMLInputElement} */ (form.querySelector('#add-user-name')).value.trim(),
      email: /** @type {HTMLInputElement} */ (form.querySelector('#add-user-email')).value.trim(),
      role: /** @type {HTMLSelectElement} */ (form.querySelector('#add-user-role')).value || null,
    };

    const { valid, errors } = validateInviteUserForm(values);
    if (!valid) {
      errorEl.textContent = Object.values(errors)[0];
      errorEl.classList.remove('hidden');
      return;
    }

    submitBtn.disabled = true;
    const { error } = await inviteUser(values);
    submitBtn.disabled = false;

    if (error) {
      errorEl.textContent = error.message;
      errorEl.classList.remove('hidden');
      return;
    }

    close();
    onInvited?.();
  }

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    submit();
  });
}
