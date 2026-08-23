// Sign-in / sign-up. Real Supabase Auth flow — see src/auth.js for the
// logic; this module is DOM wiring only. Phase 0: no role selection at
// sign-up — role assignment is an Admin action added in Phase 1.
import { signIn, signUp, getSessionUser } from '../auth.js';

export async function render(container) {
  const alreadySignedIn = await getSessionUser();
  if (alreadySignedIn) {
    window.location.hash = '#/dashboard';
    return;
  }

  container.innerHTML = `
    <div class="min-h-screen flex items-center justify-center p-4" data-screen="login">
      <div class="card elev-md" style="width:min(400px,100%)">
        <div class="flex items-center gap-2 mb-1">
          <svg width="18" height="18" viewBox="0 0 256 256" fill="none">
            <rect x="28" y="28" width="200" height="200" rx="28" fill="none" stroke="var(--color-accent)" stroke-width="16"/>
            <path d="M76 128 L112 164 L180 92" stroke="var(--color-accent)" stroke-width="16" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
          </svg>
          <div class="card-kicker" style="margin:0">Inventory &amp; Stock Management</div>
        </div>
        <p style="font-size:12px;color:var(--color-neutral-500);margin:0 0 16px">by ASK Info-Solutions LLP</p>

        <div class="seg" role="radiogroup" aria-label="Sign in or sign up" style="margin-bottom:16px">
          <label class="seg-opt"><input type="radio" name="auth-tab" value="signin" checked />Sign In</label>
          <label class="seg-opt"><input type="radio" name="auth-tab" value="signup" />Sign Up</label>
        </div>

        <p data-role="error" class="hidden" style="font-size:13px;color:var(--color-accent-2-200);background:var(--color-accent-2-900);border:1px solid var(--color-accent-2-700);border-radius:var(--radius-md);padding:8px 12px;margin-bottom:14px"></p>
        <p data-role="notice" class="hidden" style="font-size:13px;color:var(--color-accent-100);background:var(--color-accent-900);border:1px solid var(--color-accent-700);border-radius:var(--radius-md);padding:8px 12px;margin-bottom:14px">New accounts have no module access until an Admin assigns a role (Phase 1).</p>

        <form data-form="signin" class="space-y-3">
          <div class="field"><label for="signin-email">Email</label>
            <input class="input" id="signin-email" name="email" type="email" required autocomplete="email" />
          </div>
          <div class="field"><label for="signin-password">Password</label>
            <input class="input" id="signin-password" name="password" type="password" required autocomplete="current-password" />
          </div>
          <button type="submit" class="btn btn-primary btn-block">Sign In</button>
        </form>

        <form data-form="signup" class="hidden space-y-3">
          <div class="field"><label for="signup-name">Name</label>
            <input class="input" id="signup-name" name="name" type="text" required autocomplete="name" />
          </div>
          <div class="field"><label for="signup-email">Email</label>
            <input class="input" id="signup-email" name="email" type="email" required autocomplete="email" />
          </div>
          <div class="field"><label for="signup-password">Password</label>
            <input class="input" id="signup-password" name="password" type="password" required minlength="6" autocomplete="new-password" />
          </div>
          <button type="submit" class="btn btn-primary btn-block">Create Account</button>
        </form>
      </div>
    </div>
  `;

  const errorEl = container.querySelector('[data-role="error"]');
  const noticeEl = container.querySelector('[data-role="notice"]');
  const signinForm = container.querySelector('[data-form="signin"]');
  const signupForm = container.querySelector('[data-form="signup"]');

  function showError(message) {
    noticeEl.classList.add('hidden');
    errorEl.textContent = message;
    errorEl.classList.remove('hidden');
  }

  function clearMessages() {
    errorEl.classList.add('hidden');
    noticeEl.classList.add('hidden');
  }

  container.querySelectorAll('input[name="auth-tab"]').forEach((radio) => {
    radio.addEventListener('change', () => {
      clearMessages();
      if (radio.checked) {
        signinForm.classList.toggle('hidden', radio.value !== 'signin');
        signupForm.classList.toggle('hidden', radio.value !== 'signup');
        if (radio.value === 'signup') noticeEl.classList.remove('hidden');
      }
    });
  });

  signinForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    clearMessages();
    const { error } = await signIn({
      email: container.querySelector('#signin-email').value.trim(),
      password: container.querySelector('#signin-password').value,
    });
    if (error) {
      showError(error.message);
      return;
    }
    window.location.hash = '#/dashboard';
  });

  signupForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    clearMessages();
    const { error } = await signUp({
      name: container.querySelector('#signup-name').value.trim(),
      email: container.querySelector('#signup-email').value.trim(),
      password: container.querySelector('#signup-password').value,
    });
    if (error) {
      showError(error.message);
      return;
    }
    window.location.hash = '#/dashboard';
  });
}
