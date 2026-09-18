import { h, toast, errMsg } from './util.js';
import { api, state } from './state.js';

const COMMON = ['password', 'passwort', '123456', 'qwerty', 'letmein', 'welcome', 'iloveyou', 'admin', 'dailies', 'shotlist'];

/** Returns a message when the password is too weak, else ''. */
export function passwordProblem(pw, email = '') {
  if (pw.length < 10) return 'Use at least 10 characters.';
  if (pw.length > 72) return 'Use at most 72 characters.';
  const lower = pw.toLowerCase();
  if (COMMON.some((c) => lower.includes(c))) return 'Avoid common words like “password”.';
  const local = email.split('@')[0].toLowerCase();
  if (local.length >= 3 && lower.includes(local)) return 'Do not include your email name.';
  const kinds = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((r) => r.test(pw)).length;
  if (kinds < 3 && pw.length < 16) return 'Mix upper case, lower case, digits and symbols, or use 16+ characters.';
  return '';
}

function shell(title, ...body) {
  return h('main.auth', h('div.auth-card',
    h('div.brand', h('span.brand-mark', '▶'), h('span', 'Production Tracker')),
    h('h1', title), ...body));
}

export function renderAuth(root, mode = 'signin') {
  const email = h('input', { type: 'email', required: true, autocomplete: 'email', 'aria-label': 'Email' });
  const pw = h('input', { type: 'password', required: true, autocomplete: mode === 'signup' ? 'new-password' : 'current-password', 'aria-label': 'Password' });
  const pw2 = h('input', { type: 'password', required: true, autocomplete: 'new-password', 'aria-label': 'Repeat password' });
  const name = h('input', { required: true, maxLength: 80, autocomplete: 'name', 'aria-label': 'Your name' });
  const msg = h('p.form-msg', { role: 'alert' });
  const submit = h('button.btn.primary.block', { type: 'submit' });
  const hint = h('p.pw-hint');
  const busy = (b) => { submit.disabled = b; };

  const switchTo = (m) => h('button.link-btn', { type: 'button', on: { click: () => renderAuth(root, m) } });

  let form;
  if (mode === 'signin') {
    submit.textContent = 'Sign in';
    form = h('form.form', h('label', 'Email', email), h('label', 'Password', pw), msg, submit);
    form.addEventListener('submit', async (e) => {
      e.preventDefault(); busy(true); msg.textContent = '';
      try { await api().auth.signIn(email.value.trim(), pw.value); }
      catch (err) {
        const m = errMsg(err);
        msg.textContent = /confirm/i.test(m) ? 'Please confirm your email first — check your inbox.' : 'Wrong email or password.';
        busy(false);
      }
    });
    root.replaceChildren(shell('Sign in', form,
      h('p.auth-links', 'No account? ', Object.assign(switchTo('signup'), { textContent: 'Register' }), ' · ',
        Object.assign(switchTo('forgot'), { textContent: 'Forgot password' }))));
  } else if (mode === 'signup') {
    submit.textContent = 'Create account';
    pw.addEventListener('input', () => { hint.textContent = pw.value ? passwordProblem(pw.value, email.value) || 'Strong enough ✓' : ''; });
    form = h('form.form', h('label', 'Your name', name), h('label', 'Email', email), h('label', 'Password', pw), hint,
      h('label', 'Repeat password', pw2), msg, submit);
    form.addEventListener('submit', async (e) => {
      e.preventDefault(); msg.textContent = '';
      const bad = passwordProblem(pw.value, email.value);
      if (bad) { msg.textContent = bad; return; }
      if (pw.value !== pw2.value) { msg.textContent = 'Passwords do not match.'; return; }
      busy(true);
      try {
        await api().auth.signUp(email.value.trim(), pw.value, name.value.trim());
        root.replaceChildren(shell('Check your inbox',
          h('p', 'We sent a confirmation link to ', h('strong', email.value.trim()), '.'),
          h('p', 'After you confirm, a project admin must approve your account before you can see anything.'),
          Object.assign(switchTo('signin'), { textContent: 'Back to sign in' })));
      } catch (err) { msg.textContent = errMsg(err); busy(false); }
    });
    root.replaceChildren(shell('Register', h('p.faint', 'Access to project data needs admin approval after you register.'), form,
      h('p.auth-links', 'Have an account? ', Object.assign(switchTo('signin'), { textContent: 'Sign in' }))));
  } else if (mode === 'forgot') {
    submit.textContent = 'Send reset link';
    form = h('form.form', h('label', 'Email', email), msg, submit);
    form.addEventListener('submit', async (e) => {
      e.preventDefault(); busy(true);
      try { await api().auth.resetPassword(email.value.trim()); } catch { /* same answer either way */ }
      msg.textContent = 'If that address has an account, a reset link is on its way.';
    });
    root.replaceChildren(shell('Reset password', form,
      h('p.auth-links', Object.assign(switchTo('signin'), { textContent: 'Back to sign in' }))));
  } else if (mode === 'recover') {
    submit.textContent = 'Set new password';
    form = h('form.form', h('label', 'New password', pw), hint, h('label', 'Repeat password', pw2), msg, submit);
    pw.addEventListener('input', () => { hint.textContent = pw.value ? passwordProblem(pw.value) || 'Strong enough ✓' : ''; });
    form.addEventListener('submit', async (e) => {
      e.preventDefault(); msg.textContent = '';
      const bad = passwordProblem(pw.value);
      if (bad) { msg.textContent = bad; return; }
      if (pw.value !== pw2.value) { msg.textContent = 'Passwords do not match.'; return; }
      busy(true);
      try { await api().auth.setPassword(pw.value); toast('Password updated'); location.hash = ''; location.reload(); }
      catch (err) { msg.textContent = errMsg(err); busy(false); }
    });
    root.replaceChildren(shell('Choose a new password', form));
  }
  (mode === 'recover' ? pw : mode === 'signup' ? name : email).focus();
}

export function renderPending(root, onRetry) {
  const confirmed = state.me?.email_confirmed !== false;
  root.replaceChildren(shell(confirmed ? 'Waiting for approval' : 'Confirm your email',
    h('p', 'Signed in as ', h('strong', state.me?.email || ''), '.'),
    h('p', confirmed
      ? 'Your account works, but a project admin has not approved it yet. Ask them to approve you, then press “Check again”.'
      : 'Open the confirmation link we emailed you, then press “Check again”.'),
    h('div.row',
      h('button.btn.primary', { type: 'button', on: { click: onRetry } }, 'Check again'),
      h('button.btn', { type: 'button', on: { click: () => api().auth.signOut() } }, 'Sign out'))));
}

export function renderSetup(root) {
  root.replaceChildren(shell('Not configured yet',
    h('p', 'This build has no Supabase project connected. Follow the setup steps in the README, then redeploy.'),
    h('p', h('a', { href: '?demo' }, 'Open the local demo'), ' to try the interface. Demo data stays in this browser only.')));
}
