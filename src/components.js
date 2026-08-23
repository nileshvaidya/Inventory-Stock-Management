// Shared render helpers used across screen modules.
export function escapeHtml(value) {
  const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  return String(value).replace(/[&<>"']/g, (char) => map[char]);
}

export function initials(name) {
  return String(name)
    .trim()
    .split(/\s+/)
    .map((part) => part[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();
}

/**
 * Sidebar identity block: avatar initials + name + email, from the
 * logged-in user's profile. Returns a DOM node so callers can mount it
 * wherever the sidebar chrome ends up living.
 * @param {{ name: string, email: string }} user
 */
export function renderIdentityBlock(user) {
  const el = document.createElement('div');
  el.setAttribute('data-component', 'identity-block');
  el.style.cssText = 'display:flex;align-items:center;gap:10px';
  el.innerHTML = `
    <div style="width:32px;height:32px;border-radius:50%;background:var(--color-accent-800);color:var(--color-accent-100);display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:600;flex:none">${escapeHtml(initials(user.name))}</div>
    <div style="min-width:0">
      <div data-role="identity-name" style="font-size:13px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(user.name)}</div>
      <div data-role="identity-email" style="font-size:11px;color:var(--color-neutral-500);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(user.email)}</div>
    </div>
  `;
  return el;
}
