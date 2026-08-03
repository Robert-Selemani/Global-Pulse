'use strict';

/**
 * Account page: shows the signed-in user's email, role, and plan, and lets them
 * change their own password (requires the current one). The sidebar handles
 * auth and log out.
 */
(function () {
  const $ = (id) => document.getElementById(id);
  const el = {
    email: $('acct-email'),
    role: $('acct-role'),
    plan: $('acct-plan'),
    form: $('password-form'),
    current: $('current-password'),
    next: $('new-password'),
    next2: $('new-password2'),
    message: $('password-message'),
    btn: $('password-btn'),
  };

  function setMessage(text, kind) {
    el.message.textContent = text || '';
    el.message.className = 'form-message' + (kind ? ' ' + kind : '');
  }

  async function apiJson(url, options) {
    const res = await fetch(url, options);
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(payload.error || 'Request failed');
    return payload;
  }

  const ROLE_LABEL = { super_admin: 'Super admin', end_user: 'Organizer' };

  async function loadDetails() {
    try {
      const session = await apiJson('/api/session');
      el.email.textContent = session.email || '—';
      el.role.textContent = ROLE_LABEL[session.role] || session.role || '—';
    } catch (_) {
      /* sidebar will have redirected if signed out */
    }
    try {
      const [{ subscription }, { plans }] = await Promise.all([
        apiJson('/api/subscription'),
        apiJson('/api/plans'),
      ]);
      if (subscription) {
        const plan = (plans || []).find((p) => p.id === subscription.planId);
        el.plan.textContent = plan ? plan.name : subscription.planId;
      }
    } catch (_) {
      el.plan.textContent = '—';
    }
  }

  el.form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const next = el.next.value;
    if (next.length < 6) return setMessage('New password must be at least 6 characters.', 'error');
    if (next !== el.next2.value) return setMessage('The two new passwords do not match.', 'error');
    el.btn.disabled = true;
    setMessage('Saving…', '');
    try {
      await apiJson('/api/change-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentPassword: el.current.value, newPassword: next }),
      });
      el.form.reset();
      setMessage('Password updated ✅', 'success');
    } catch (err) {
      setMessage(err.message, 'error');
    } finally {
      el.btn.disabled = false;
    }
  });

  loadDetails();
})();
