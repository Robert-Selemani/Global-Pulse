/* global GP */
'use strict';

/**
 * Presentation page: a public, read-only live map for display on screens.
 *
 * When opened at /p/<slug> it shows that specific poll; at / or /present it
 * falls back to the default (legacy) poll via the global data alias.
 */
(function () {
  const m = location.pathname.match(/^\/p\/([a-z0-9-]+)$/);
  const slug = m ? m[1] : null;

  const titleEl = document.getElementById('present-title');
  const badgeEl = document.getElementById('present-badge');
  const participateEl = document.getElementById('participate-link');
  const taglineEl = document.querySelector('.tagline');

  async function applyConfig() {
    if (!slug) return true; // default poll: keep the generic branding
    try {
      const res = await fetch('/api/poll/' + slug + '/config');
      if (!res.ok) throw new Error('not found');
      const cfg = await res.json();
      if (titleEl) titleEl.textContent = cfg.title || 'Global Pulse';
      document.title = (cfg.title || 'Global Pulse') + ' — Live Map';

      const archived = cfg.status === 'archived';
      if (archived) {
        if (badgeEl) {
          badgeEl.textContent = 'Archived';
          badgeEl.hidden = false;
        }
        // An archived poll is a snapshot, not a live feed.
        if (taglineEl) taglineEl.textContent = 'Final results — this poll has ended';
      }
      // Point participants at this poll — an archived poll takes no entries.
      if (participateEl) {
        if (archived) participateEl.hidden = true;
        else participateEl.href = '/vote?poll=' + encodeURIComponent(slug);
      }

      GP.setDataUrl('/api/poll/' + slug + '/data');
      return !archived;
    } catch (_) {
      if (titleEl) titleEl.textContent = 'Poll not found';
      if (participateEl) participateEl.hidden = true;
      return false;
    }
  }

  (async function boot() {
    const live = await applyConfig();
    GP.initMap();
    try {
      await GP.boot();
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('Failed to load presentation:', err);
      return;
    }
    // Archived polls are static — no need to poll for updates.
    if (live) GP.startPolling();
  })();
})();
