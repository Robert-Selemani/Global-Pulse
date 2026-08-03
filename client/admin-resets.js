'use strict';

/**
 * Password resets page (super admin only): pick an account and generate a
 * one-time reset link to hand over out-of-band. Guards against non-admins.
 */
(function () {
  const $ = (id) => document.getElementById(id);
  const el = {
    form: $('reset-link-form'),
    select: $('reset-user-select'),
    btn: $('reset-link-btn'),
    message: $('reset-link-message'),
    output: $('reset-link-output'),
    url: $('reset-link-url'),
    copy: $('reset-link-copy'),
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

  async function boot() {
    try {
      const session = await apiJson('/api/session');
      if (!session.isSuperAdmin) {
        location.href = '/dashboard';
        return;
      }
    } catch (_) {
      return; // sidebar handles the signed-out redirect
    }

    try {
      const { users } = await apiJson('/api/admin/users');
      el.select.innerHTML = '';
      for (const u of users || []) {
        const opt = document.createElement('option');
        opt.value = u.email;
        opt.textContent = u.email + (u.role === 'super_admin' ? ' (super admin)' : '');
        el.select.appendChild(opt);
      }
    } catch (err) {
      setMessage(err.message, 'error');
    }
  }

  el.form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = el.select.value;
    if (!email) return;
    el.btn.disabled = true;
    el.output.hidden = true;
    setMessage('Generating…', '');
    try {
      const { resetPath, expiresInMinutes } = await apiJson('/api/admin/reset-link', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      el.url.value = location.origin + resetPath;
      el.output.hidden = false;
      setMessage(
        'Send this link to ' + email + '. It works once and expires in ' + expiresInMinutes + ' minutes.',
        'success'
      );
    } catch (err) {
      setMessage(err.message, 'error');
    } finally {
      el.btn.disabled = false;
    }
  });

  el.copy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(el.url.value);
      el.copy.textContent = 'Copied ✓';
      setTimeout(() => (el.copy.textContent = 'Copy link'), 1500);
    } catch (_) {
      el.url.select();
    }
  });

  boot();
})();
