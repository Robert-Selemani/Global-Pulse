/* global GP, qrcode */
'use strict';

/**
 * Presentation page: a public, read-only live map for display on screens.
 *
 * When opened at /results/<slug> (or the legacy /p/<slug>) it shows that
 * specific poll; at / or /present it falls back to the default (legacy) poll.
 *
 * Presentation extras: a "Scan to join" QR, header stats that count up, and a
 * live ticker that announces (and flashes on the map) each new community.
 */
(function () {
  const m = location.pathname.match(/^\/(?:results|p)\/([a-z0-9-]+)$/);
  const slug = m ? m[1] : null;

  const titleEl = document.getElementById('present-title');
  const badgeEl = document.getElementById('present-badge');
  const participateEl = document.getElementById('participate-link');
  const taglineEl = document.querySelector('.tagline');
  const joinQrEl = document.getElementById('join-qr');
  const joinQrCodeEl = document.getElementById('join-qr-code');
  const tickerEl = document.getElementById('ticker');

  // -------------------------------------------------------------------------
  // "Scan to join" QR
  // -------------------------------------------------------------------------
  function showJoinQr(url) {
    if (!joinQrEl || !joinQrCodeEl || !window.qrcode) return;
    try {
      const qr = qrcode(0, 'M');
      qr.addData(url);
      qr.make();
      joinQrCodeEl.innerHTML = qr.createImgTag(4, 2);
      const img = joinQrCodeEl.querySelector('img');
      if (img) img.alt = 'QR code to join this poll';
      joinQrEl.hidden = false;
    } catch (_) {
      /* leave the QR hidden if it can't render */
    }
  }

  // -------------------------------------------------------------------------
  // Header stats: count up to each new total
  // -------------------------------------------------------------------------
  const statEls = {
    countries: document.getElementById('stat-countries'),
    communities: document.getElementById('stat-communities'),
    users: document.getElementById('stat-users'),
  };
  const shown = { countries: 0, communities: 0, users: 0 };
  const rafs = { countries: 0, communities: 0, users: 0 };

  function tweenStat(key, target) {
    const node = statEls[key];
    if (!node) return;
    const from = shown[key];
    if (from === target) {
      node.textContent = String(target);
      return;
    }
    if (rafs[key]) cancelAnimationFrame(rafs[key]);
    const dur = 650;
    const start = performance.now();
    const step = (now) => {
      const p = Math.min(1, (now - start) / dur);
      const eased = 1 - Math.pow(1 - p, 3); // easeOutCubic
      node.textContent = String(Math.round(from + (target - from) * eased));
      if (p < 1) {
        rafs[key] = requestAnimationFrame(step);
      } else {
        shown[key] = target;
        rafs[key] = 0;
      }
    };
    rafs[key] = requestAnimationFrame(step);
  }

  function tweenStats(totals) {
    const t = totals || {};
    tweenStat('countries', t.activeCountries || 0);
    tweenStat('communities', t.totalCommunities || 0);
    tweenStat('users', t.totalUsers || 0);
  }

  // -------------------------------------------------------------------------
  // Live ticker: announce each newly added community, flash its country
  // -------------------------------------------------------------------------
  const SEP = '\u0001';
  let seen = null; // Set of "countryId\0community"; null until first snapshot

  function flagImg(countryId) {
    const iso2 = GP.state.flags && GP.state.flags[countryId];
    if (!iso2) return null;
    const img = document.createElement('img');
    img.className = 'toast-flag';
    img.src = GP.FLAG_BASE + '/' + iso2 + '.png';
    img.alt = '';
    return img;
  }

  function announce(countryId, countryName, community) {
    if (!tickerEl) return;
    const toast = document.createElement('div');
    toast.className = 'toast';
    const flag = flagImg(countryId);
    if (flag) toast.appendChild(flag);
    const text = document.createElement('span');
    const strong = document.createElement('strong');
    strong.textContent = community;
    text.appendChild(strong);
    text.appendChild(document.createTextNode(' joined from ' + countryName));
    toast.appendChild(text);
    tickerEl.appendChild(toast);
    // Trigger the slide-in on the next frame.
    requestAnimationFrame(() => toast.classList.add('show'));
    // Retire it, and cap how many stack up.
    setTimeout(() => {
      toast.classList.remove('show');
      setTimeout(() => toast.remove(), 400);
    }, 5000);
    while (tickerEl.children.length > 4) tickerEl.removeChild(tickerEl.firstChild);
  }

  function diffAndAnnounce(data) {
    const countries = (data && data.countries) || {};
    const current = new Set();
    const fresh = [];
    for (const id of Object.keys(countries)) {
      const c = countries[id];
      for (const comm of c.communities || []) {
        const key = id + SEP + comm.name;
        current.add(key);
        if (seen && !seen.has(key)) fresh.push({ id, name: c.name, community: comm.name });
      }
    }
    // On the first snapshot we only seed - we don't announce the backlog.
    if (seen) {
      for (const f of fresh.slice(0, 4)) {
        announce(f.id, f.name, f.community);
        GP.pulseCountry(f.id);
      }
    }
    seen = current;
  }

  // -------------------------------------------------------------------------
  // Full-screen focus for a single metric (Countries / Communities / Participants)
  // -------------------------------------------------------------------------
  const focusEl = document.getElementById('focus-view');
  const focusTitleEl = document.getElementById('focus-title');
  const focusValueEl = document.getElementById('focus-value');
  const focusSubEl = document.getElementById('focus-sub');
  const focusBodyEl = document.getElementById('focus-body');
  const focusCloseEl = document.getElementById('focus-close');
  const TITLES = { countries: 'Countries', communities: 'Communities', participants: 'Participants' };
  let focusMetric = null;

  function count(n, singular, plural) {
    return n + ' ' + (n === 1 ? singular : plural);
  }

  function flagFor(countryId) {
    const iso2 = GP.state.flags && GP.state.flags[countryId];
    if (!iso2) return null;
    const img = document.createElement('img');
    img.className = 'toast-flag';
    img.src = GP.FLAG_BASE + '/' + iso2 + '.png';
    img.alt = '';
    return img;
  }

  function countriesBy(key) {
    return Object.values(GP.state.data.countries || {}).sort(
      (a, b) => b[key] - a[key] || a.name.localeCompare(b.name)
    );
  }

  function countryRow(c, detail) {
    const row = document.createElement('div');
    row.className = 'fcard';
    const flag = flagFor(c.id);
    if (flag) row.appendChild(flag);
    const txt = document.createElement('div');
    const name = document.createElement('strong');
    name.textContent = c.name;
    const sub = document.createElement('span');
    sub.textContent = detail;
    txt.appendChild(name);
    txt.appendChild(sub);
    row.appendChild(txt);
    return row;
  }

  function renderFocusBody(metric) {
    focusBodyEl.innerHTML = '';
    const t = GP.state.data.totals || {};
    if (metric === 'participants') {
      focusSubEl.textContent =
        'across ' + count(t.totalCommunities || 0, 'community', 'communities') +
        ' in ' + count(t.activeCountries || 0, 'country', 'countries');
      const grid = document.createElement('div');
      grid.className = 'fgrid';
      for (const c of countriesBy('totalUsers')) {
        grid.appendChild(countryRow(c, count(c.totalUsers, 'participant', 'participants')));
      }
      focusBodyEl.appendChild(grid);
    } else if (metric === 'countries') {
      focusSubEl.textContent = 'represented so far';
      const grid = document.createElement('div');
      grid.className = 'fgrid';
      for (const c of countriesBy('totalUsers')) {
        grid.appendChild(
          countryRow(
            c,
            count(c.totalUsers, 'participant', 'participants') +
              ' · ' +
              count(c.uniqueCommunities, 'community', 'communities')
          )
        );
      }
      focusBodyEl.appendChild(grid);
    } else {
      // communities: every community name, grouped visually by country
      focusSubEl.textContent = 'from around the world';
      const wrap = document.createElement('div');
      wrap.className = 'fchips';
      for (const c of countriesBy('uniqueCommunities')) {
        for (const comm of c.communities || []) {
          const chip = document.createElement('div');
          chip.className = 'fchip';
          const flag = flagFor(c.id);
          if (flag) chip.appendChild(flag);
          const name = document.createElement('span');
          name.textContent = comm.name;
          chip.appendChild(name);
          wrap.appendChild(chip);
        }
      }
      focusBodyEl.appendChild(wrap);
    }
  }

  function focusValueFor(metric) {
    const t = GP.state.data.totals || {};
    if (metric === 'participants') return t.totalUsers || 0;
    if (metric === 'communities') return t.totalCommunities || 0;
    return t.activeCountries || 0;
  }

  function countUp(node, to) {
    const from = 0;
    if (to === 0) {
      node.textContent = '0';
      return;
    }
    const dur = 700;
    const start = performance.now();
    const step = (now) => {
      const p = Math.min(1, (now - start) / dur);
      const eased = 1 - Math.pow(1 - p, 3);
      node.textContent = String(Math.round(from + to * eased));
      if (p < 1 && focusMetric) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  function openFocus(metric) {
    focusMetric = metric;
    focusTitleEl.textContent = TITLES[metric];
    renderFocusBody(metric);
    focusEl.hidden = false;
    document.body.classList.add('focus-open');
    countUp(focusValueEl, focusValueFor(metric));
    focusCloseEl.focus();
  }

  function closeFocus() {
    focusMetric = null;
    focusEl.hidden = true;
    document.body.classList.remove('focus-open');
  }

  if (focusEl) {
    document.querySelectorAll('.stat[data-metric]').forEach((li) => {
      const metric = li.getAttribute('data-metric');
      li.addEventListener('click', () => openFocus(metric));
      li.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          openFocus(metric);
        }
      });
    });
    focusCloseEl.addEventListener('click', closeFocus);
    focusEl.addEventListener('click', (e) => {
      if (e.target === focusEl) closeFocus(); // click the backdrop
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && focusMetric) closeFocus();
    });
  }

  function onData(data) {
    if (window.GPChart) GPChart.render(data);
    tweenStats(data && data.totals);
    diffAndAnnounce(data);
    // Keep an open focus view live (update the number and list in place).
    if (focusMetric) {
      focusValueEl.textContent = String(focusValueFor(focusMetric));
      renderFocusBody(focusMetric);
    }
  }

  // -------------------------------------------------------------------------
  // Config + boot
  // -------------------------------------------------------------------------
  let pollContinent = '';

  async function applyConfig() {
    if (!slug) return true; // default poll: keep the generic branding
    try {
      const res = await fetch('/api/poll/' + slug + '/config');
      if (!res.ok) throw new Error('not found');
      const cfg = await res.json();
      if (titleEl) titleEl.textContent = cfg.title || 'Global Pulse';
      document.title = (cfg.title || 'Global Pulse') + ' - Results';

      const archived = cfg.status === 'archived';
      if (archived) {
        if (badgeEl) {
          badgeEl.textContent = 'Archived';
          badgeEl.hidden = false;
        }
        // An archived poll is a snapshot, not a live feed.
        if (taglineEl) taglineEl.textContent = 'Final results - this poll has ended';
      }
      // Point participants at this poll - an archived poll takes no entries.
      if (participateEl) {
        if (archived) participateEl.hidden = true;
        else participateEl.href = '/vote?poll=' + encodeURIComponent(slug);
      }

      GP.setDataUrl('/api/poll/' + slug + '/data');
      pollContinent = cfg.focusContinent || '';
      return !archived;
    } catch (_) {
      if (titleEl) titleEl.textContent = 'Poll not found';
      if (participateEl) participateEl.hidden = true;
      return false;
    }
  }

  (async function boot() {
    const chartEl = document.getElementById('communities-chart');
    if (chartEl && window.GPChart) GPChart.mount(chartEl);

    // This page owns the header stat numbers (count-up), and handles the chart,
    // ticker, and pulses via a single data handler.
    GP.useExternalStats();
    GP.onData(onData);

    const live = await applyConfig();

    // Show the join QR once the participate target is resolved (live polls only).
    if (live && participateEl && !participateEl.hidden) showJoinQr(participateEl.href);

    GP.initMap();
    try {
      await GP.boot();
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('Failed to load presentation:', err);
      return;
    }
    // A pinned poll presents filled with its continent - nothing to zoom.
    if (pollContinent) GP.setPollContinent(pollContinent);
    // Archived polls are static - no need to poll for updates.
    if (live) GP.startPolling();
  })();
})();
