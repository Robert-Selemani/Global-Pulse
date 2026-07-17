'use strict';

/**
 * Shared login / signup logic. The same script serves both pages; it detects
 * which form is present. On success it redirects to the voting page (carrying
 * any participation ?code= through so a scanned QR still works).
 */
(function () {
  const isSignup = !!document.getElementById('signup-form');
  const form = document.getElementById(isSignup ? 'signup-form' : 'login-form');
  const emailEl = document.getElementById('auth-email');
  const passwordEl = document.getElementById('auth-password');
  const messageEl = document.getElementById('auth-message');
  const submitEl = document.getElementById('auth-submit');

  const params = new URLSearchParams(location.search);
  const next = params.get('next') || '/dashboard';

  function destination() {
    // `next` already carries any poll/code query (set by the page that
    // redirected here), so honour it as-is; otherwise go to the dashboard.
    return next || '/dashboard';
  }

  // On the signup page, tell the very first visitor they'll be super admin.
  if (isSignup) {
    fetch('/api/session')
      .then((r) => r.json())
      .then((s) => {
        const banner = document.getElementById('first-user-banner');
        if (banner && !s.hasUsers) banner.hidden = false;
      })
      .catch(() => {});
  }

  function setMessage(text, kind) {
    messageEl.textContent = text;
    messageEl.className = 'form-message' + (kind ? ' ' + kind : '');
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = emailEl.value.trim();
    const password = passwordEl.value;
    if (!email || !password) return setMessage('Please fill in both fields.', 'error');

    submitEl.disabled = true;
    setMessage(isSignup ? 'Creating account…' : 'Signing in…', '');

    try {
      const res = await fetch(isSignup ? '/api/signup' : '/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      const payload = await res.json();
      if (!res.ok) throw new Error(payload.error || 'Something went wrong.');
      window.location.href = destination();
    } catch (err) {
      setMessage(err.message, 'error');
      submitEl.disabled = false;
    }
  });
})();
