'use strict';

/**
 * Users page (super admin only): lists every account with its role. Guards
 * against non-admins reaching it by URL.
 */
(function () {
  const listEl = document.getElementById('users-list');
  const ROLE_LABEL = { super_admin: 'Super admin', end_user: 'Organizer' };

  async function apiJson(url) {
    const res = await fetch(url);
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(payload.error || 'Request failed');
    return payload;
  }

  async function boot() {
    // Non-super-admins have no business here — send them back to Polls.
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
      listEl.innerHTML = '';
      for (const u of users || []) {
        const li = document.createElement('li');
        const name = document.createElement('span');
        name.textContent = u.email;
        const tag = document.createElement('span');
        tag.className = 'badge';
        tag.textContent = ROLE_LABEL[u.role] || u.role;
        li.appendChild(name);
        li.appendChild(tag);
        listEl.appendChild(li);
      }
    } catch (err) {
      const li = document.createElement('li');
      li.className = 'hint';
      li.textContent = err.message;
      listEl.appendChild(li);
    }
  }

  boot();
})();
