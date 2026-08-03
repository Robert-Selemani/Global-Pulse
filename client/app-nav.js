'use strict';

/**
 * Shared organizer sidebar. Any authenticated page includes a
 * `<div id="app-sidebar"></div>` placeholder and this script; it renders the
 * left nav in place — highlighting the current page, hiding super-admin-only
 * items for non-admins, wiring log out, and pointing "Results" at the newest
 * real poll (not the empty default). Redirects to /login if not signed in.
 */
(function () {
  const mount = document.getElementById('app-sidebar');
  if (!mount) return;
  const path = location.pathname;

  const ITEMS = [
    { label: 'Results', href: '/present', match: ['/present', '/p/'] },
    { label: 'Polls', href: '/dashboard', match: ['/dashboard'] },
    { label: 'Account', href: '/account', match: ['/account'] },
    { label: 'Users', href: '/admin/users', match: ['/admin/users'], admin: true },
    { label: 'Password resets', href: '/admin/resets', match: ['/admin/resets'], admin: true },
  ];

  function isActive(item) {
    return item.match.some((m) => (m.endsWith('/') ? path.startsWith(m) : path === m));
  }

  async function render() {
    let session = { authenticated: false };
    try {
      session = await fetch('/api/session').then((r) => r.json());
    } catch (_) {
      /* treat as signed out */
    }
    if (!session.authenticated) {
      location.href = '/login?next=' + encodeURIComponent(path);
      return;
    }

    const nav = document.createElement('nav');
    nav.className = 'app-sidebar';

    const brand = document.createElement('div');
    brand.className = 'app-brand';
    brand.innerHTML = '<span class="pulse-dot" aria-hidden="true"></span><span>Global Pulse</span>';
    nav.appendChild(brand);

    const ul = document.createElement('ul');
    ul.className = 'app-nav';
    for (const item of ITEMS) {
      if (item.admin && !session.isSuperAdmin) continue;
      const li = document.createElement('li');
      const a = document.createElement('a');
      a.href = item.href;
      a.textContent = item.label;
      a.className = 'app-nav-link' + (isActive(item) ? ' active' : '');
      li.appendChild(a);
      ul.appendChild(li);
    }
    nav.appendChild(ul);

    const foot = document.createElement('div');
    foot.className = 'app-nav-foot';
    if (session.email) {
      const em = document.createElement('div');
      em.className = 'app-nav-email';
      em.textContent = session.email;
      foot.appendChild(em);
    }
    const out = document.createElement('button');
    out.type = 'button';
    out.className = 'admin-btn ghost full';
    out.textContent = 'Log out';
    out.addEventListener('click', async () => {
      try {
        await fetch('/api/logout', { method: 'POST' });
      } catch (_) {
        /* ignore */
      }
      location.href = '/present';
    });
    foot.appendChild(out);
    nav.appendChild(foot);

    mount.replaceWith(nav);

    // Point "Results" at the newest real poll (active preferred) so it opens
    // live data instead of the empty default poll.
    try {
      const { polls } = await fetch('/api/polls').then((r) => r.json());
      if (polls && polls.length) {
        const target = polls.find((p) => p.status !== 'archived') || polls[0];
        const link = nav.querySelector('a[href="/present"]');
        if (link && target) link.href = '/p/' + target.slug;
      }
    } catch (_) {
      /* leave Results pointing at /present */
    }
  }

  render();
})();
