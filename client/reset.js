'use strict';

/**
 * Password-reset page. Reads a one-time ?token=… (from the link an organizer
 * generated), confirms it's still valid, then lets the account owner set a new
 * password. On success it sends them to the login page.
 */
(function () {
  const token = new URLSearchParams(location.search).get('token') || '';

  const form = document.getElementById('reset-form');
  const invalid = document.getElementById('reset-invalid');
  const accountEl = document.getElementById('reset-account');
  const pw1 = document.getElementById('auth-password');
  const pw2 = document.getElementById('auth-password2');
  const messageEl = document.getElementById('auth-message');
  const submitEl = document.getElementById('auth-submit');

  function setMessage(text, kind) {
    messageEl.textContent = text || '';
    messageEl.className = 'form-message' + (kind ? ' ' + kind : '');
  }

  function showInvalid() {
    form.hidden = true;
    invalid.hidden = false;
  }

  async function init() {
    if (!token) return showInvalid();
    let payload;
    try {
      const res = await fetch('/api/reset/validate?token=' + encodeURIComponent(token));
      payload = await res.json();
    } catch (_) {
      return showInvalid();
    }
    if (!payload || !payload.valid) return showInvalid();
    accountEl.textContent = 'Resetting the password for ' + payload.email + '.';
    form.hidden = false;
    pw1.focus();
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const password = pw1.value;
    if (password.length < 6) return setMessage('Password must be at least 6 characters.', 'error');
    if (password !== pw2.value) return setMessage('The two passwords do not match.', 'error');

    submitEl.disabled = true;
    setMessage('Saving…', '');
    try {
      const res = await fetch('/api/reset-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, password }),
      });
      const payload = await res.json();
      if (!res.ok) throw new Error(payload.error || 'Could not reset your password.');
      setMessage('Password updated ✅ Redirecting to log in…', 'success');
      setTimeout(() => (location.href = '/login'), 1200);
    } catch (err) {
      setMessage(err.message, 'error');
      submitEl.disabled = false;
    }
  });

  init();
})();
