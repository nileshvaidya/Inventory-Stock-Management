// Pure validation logic — no DOM, no Supabase — cheap to unit test directly.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Phase 0 sign-up: name/email/password only. Role assignment is an Admin
 * action added in Phase 1 (see README.md) — a new account has no role
 * until then.
 * @param {{ name?: string, email?: string, password?: string }} form
 * @returns {{ valid: boolean, errors: Record<string, string> }}
 */
export function validateSignupForm(form) {
  /** @type {Record<string, string>} */
  const errors = {};
  const { name = '', email = '', password = '' } = form || {};

  if (!name.trim()) errors.name = 'Name is required.';
  if (!email.trim()) {
    errors.email = 'Email is required.';
  } else if (!EMAIL_RE.test(email.trim())) {
    errors.email = 'Enter a valid email address.';
  }
  if (!password || password.length < 6) {
    errors.password = 'Password must be at least 6 characters.';
  }

  return { valid: Object.keys(errors).length === 0, errors };
}

/**
 * @param {{ email?: string, password?: string }} form
 */
export function validateSigninForm(form) {
  /** @type {Record<string, string>} */
  const errors = {};
  const { email = '', password = '' } = form || {};
  if (!email.trim()) errors.email = 'Email is required.';
  if (!password) errors.password = 'Password is required.';
  return { valid: Object.keys(errors).length === 0, errors };
}
