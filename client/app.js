/* global L */
'use strict';

/**
 * Global Pulse client.
 *
 * Renders a world map with Leaflet, colours countries that have at least one
 * community green, labels each active country with its unique-community count
 * and total participant pin, and drives a sidebar for entry + browsing.
 */

const POLL_INTERVAL_MS = 4000;

const state = {
  data: { countries: {}, totals: {} }, // aggregated server data
  geo: null, // GeoJSON feature collection
  continents: {}, // countryId -> continent name
  focusContinent: '', // '' means whole world
  layersById: {}, // countryId -> Leaflet layer
  selectedId: null,
  isAdmin: false, // continent focus is admin-only
};

// Continents offered in the admin focus control, in display order.
const CONTINENTS = [
  'Africa',
  'Asia',
  'Europe',
  'North America',
  'South America',
  'Oceania',
  'Antarctica',
];

const els = {
  map: document.getElementById('map'),
  mapFocus: document.getElementById('map-focus'),
  continentSelect: document.getElementById('continent-select'),
  zoomIndicator: document.getElementById('zoom-indicator'),
  countrySelect: document.getElementById('country-select'),
  communityInput: document.getElementById('community-input'),
  form: document.getElementById('entry-form'),
  submitBtn: document.getElementById('submit-btn'),
  formMessage: document.getElementById('form-message'),
  selectedName: document.getElementById('selected-country-name'),
  selectedCount: document.getElementById('selected-country-count'),
  communityHint: document.getElementById('community-hint'),
  communityList: document.getElementById('community-list'),
  statCountries: document.getElementById('stat-countries'),
  statCommunities: document.getElementById('stat-communities'),
  statUsers: document.getElementById('stat-users'),
  // Admin auth UI
  adminLoginBtn: document.getElementById('admin-login-btn'),
  adminSignedin: document.getElementById('admin-signedin'),
  adminLogoutBtn: document.getElementById('admin-logout-btn'),
  loginModal: document.getElementById('login-modal'),
  loginForm: document.getElementById('login-form'),
  adminPassword: document.getElementById('admin-password'),
  loginMessage: document.getElementById('login-message'),
  loginCancel: document.getElementById('login-cancel'),
};

// ---------------------------------------------------------------------------
// Map setup
// ---------------------------------------------------------------------------

const map = L.map('map', {
  center: [20, 10],
  zoom: 2,
  minZoom: 2,
  maxZoom: 6,
  worldCopyJump: true,
  attributionControl: false,
});

L.tileLayer(
  'https://{s}.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}{r}.png',
  { subdomains: 'abcd', maxZoom: 19 }
).addTo(map);

const labelLayer = L.layerGroup().addTo(map);

// Show the current zoom as a percentage relative to the min zoom, so every
// participant can freely pick their own view (pan for the angle, zoom for the
// level) without needing the admin's continent focus.
function updateZoomIndicator() {
  const pct = Math.round(map.getZoom() / map.getMinZoom() * 100);
  els.zoomIndicator.textContent = 'Zoom ' + pct + '%';
}
map.on('zoomend', updateZoomIndicator);

const STYLE_INACTIVE = {
  fillColor: '#33465f',
  fillOpacity: 0.55,
  color: '#1c2940',
  weight: 1,
};
const STYLE_ACTIVE = {
  fillColor: '#2fd27a',
  fillOpacity: 0.75,
  color: '#0f7a45',
  weight: 1,
};
const STYLE_SELECTED = {
  color: '#ffffff',
  weight: 2.5,
};

const STYLE_DIMMED = { fillOpacity: 0.12, opacity: 0.25 };

function inFocus(id) {
  return !state.focusContinent || state.continents[id] === state.focusContinent;
}

function styleFor(feature) {
  const info = state.data.countries[feature.id];
  const base = info && info.totalUsers > 0 ? STYLE_ACTIVE : STYLE_INACTIVE;
  if (!inFocus(feature.id)) {
    return Object.assign({}, base, STYLE_DIMMED);
  }
  if (feature.id === state.selectedId) {
    return Object.assign({}, base, STYLE_SELECTED);
  }
  return base;
}

let geoLayer = null;

function renderGeo() {
  geoLayer = L.geoJSON(state.geo, {
    style: styleFor,
    onEachFeature: (feature, layer) => {
      state.layersById[feature.id] = layer;
      layer.on('click', () => selectCountry(feature.id));
      layer.on('mouseover', () => {
        if (feature.id !== state.selectedId) {
          layer.setStyle({ fillOpacity: 0.9 });
        }
      });
      layer.on('mouseout', () => geoLayer.resetStyle(layer));
    },
  }).addTo(map);
}

/** Draw the count bubble + participant pin at each active country's centre. */
function renderLabels() {
  labelLayer.clearLayers();
  for (const id of Object.keys(state.data.countries)) {
    const info = state.data.countries[id];
    if (!info.totalUsers) continue;
    if (!inFocus(id)) continue;
    const layer = state.layersById[id];
    if (!layer) continue;

    const center = layer.getBounds().getCenter();
    const html =
      '<div class="label-inner">' +
      '<span class="count-bubble" title="Unique communities">' +
      info.uniqueCommunities +
      '</span>' +
      '<span class="user-pin" title="Participants">● ' +
      info.totalUsers +
      '</span>' +
      '</div>';

    const icon = L.divIcon({
      className: 'country-label',
      html,
      iconSize: null,
    });
    L.marker(center, { icon, interactive: false }).addTo(labelLayer);
  }
}

function refreshStyles() {
  if (geoLayer) {
    geoLayer.setStyle(styleFor);
  }
}

// ---------------------------------------------------------------------------
// Sidebar
// ---------------------------------------------------------------------------

function populateCountrySelect() {
  const features = state.geo.features
    .map((f) => ({ id: f.id, name: f.properties.name }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const frag = document.createDocumentFragment();
  for (const c of features) {
    const opt = document.createElement('option');
    opt.value = c.id;
    opt.textContent = c.name;
    opt.dataset.name = c.name;
    frag.appendChild(opt);
  }
  els.countrySelect.appendChild(frag);

  els.countrySelect.addEventListener('change', () => {
    if (els.countrySelect.value) selectCountry(els.countrySelect.value);
  });
}

/** Build the admin continent-focus dropdown (only continents that exist). */
function populateContinentSelect() {
  const present = new Set(Object.values(state.continents));
  const frag = document.createDocumentFragment();
  for (const name of CONTINENTS) {
    if (!present.has(name)) continue;
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = name;
    frag.appendChild(opt);
  }
  els.continentSelect.appendChild(frag);
  els.continentSelect.addEventListener('change', () =>
    focusContinent(els.continentSelect.value)
  );
}

/**
 * Zoom the map to a continent, restrict the country dropdown to that
 * continent, and dim countries elsewhere. An empty value resets to the world.
 */
function focusContinent(name) {
  state.focusContinent = name;
  refreshStyles();
  renderLabels();

  // Restrict the country picker to the focused continent.
  for (const opt of els.countrySelect.options) {
    if (!opt.value) continue; // keep the placeholder
    opt.hidden = !!name && state.continents[opt.value] !== name;
  }
  if (name && state.continents[els.countrySelect.value] !== name) {
    els.countrySelect.value = '';
  }

  if (!name) {
    map.setView([20, 10], 2);
    return;
  }

  const bounds = L.latLngBounds([]);
  for (const feature of state.geo.features) {
    if (state.continents[feature.id] !== name) continue;
    const layer = state.layersById[feature.id];
    if (layer) bounds.extend(layer.getBounds());
  }
  if (bounds.isValid()) {
    map.fitBounds(bounds, { padding: [30, 30], maxZoom: 5 });
  }
}

function selectCountry(id) {
  state.selectedId = id;
  els.countrySelect.value = id;
  refreshStyles();

  const info = state.data.countries[id];
  const name = info
    ? info.name
    : featureName(id) || 'Selected country';

  els.selectedName.textContent = name;

  const layer = state.layersById[id];
  if (layer) map.fitBounds(layer.getBounds(), { maxZoom: 5, padding: [40, 40] });

  renderCommunityList(info);
}

function featureName(id) {
  const f = state.geo.features.find((x) => x.id === id);
  return f ? f.properties.name : '';
}

function renderCommunityList(info) {
  els.communityList.innerHTML = '';

  if (!info || !info.communities.length) {
    els.selectedCount.textContent = '';
    els.communityHint.style.display = 'block';
    els.communityHint.textContent =
      'No communities here yet — be the first to add one!';
    return;
  }

  els.communityHint.style.display = 'none';
  els.selectedCount.textContent =
    info.uniqueCommunities +
    (info.uniqueCommunities === 1 ? ' community' : ' communities');

  const frag = document.createDocumentFragment();
  for (const c of info.communities) {
    const li = document.createElement('li');
    const nameSpan = document.createElement('span');
    nameSpan.className = 'c-name';
    nameSpan.textContent = c.name;
    const countSpan = document.createElement('span');
    countSpan.className = 'c-count';
    countSpan.textContent =
      c.count + (c.count === 1 ? ' member' : ' members');
    li.appendChild(nameSpan);
    li.appendChild(countSpan);
    frag.appendChild(li);
  }
  els.communityList.appendChild(frag);
}

function renderStats() {
  const t = state.data.totals || {};
  els.statCountries.textContent = t.activeCountries || 0;
  els.statCommunities.textContent = t.totalCommunities || 0;
  els.statUsers.textContent = t.totalUsers || 0;
}

// ---------------------------------------------------------------------------
// Data flow
// ---------------------------------------------------------------------------

async function fetchData() {
  const res = await fetch('/api/data');
  if (!res.ok) throw new Error('Failed to load data');
  return res.json();
}

function applyData(data) {
  state.data = data;
  refreshStyles();
  renderLabels();
  renderStats();
  if (state.selectedId) {
    renderCommunityList(state.data.countries[state.selectedId]);
  }
}

function setMessage(text, kind) {
  els.formMessage.textContent = text;
  els.formMessage.className = 'form-message' + (kind ? ' ' + kind : '');
}

els.form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const countryId = els.countrySelect.value;
  const opt = els.countrySelect.selectedOptions[0];
  const countryName = opt ? opt.dataset.name : '';
  const community = els.communityInput.value.trim();

  if (!countryId) return setMessage('Please choose a country.', 'error');
  if (!community) return setMessage('Please enter a community name.', 'error');

  els.submitBtn.disabled = true;
  setMessage('Adding…', '');

  try {
    const res = await fetch('/api/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ countryId, countryName, community }),
    });
    const payload = await res.json();
    if (!res.ok) throw new Error(payload.error || 'Submission failed');

    applyData(payload.data);
    state.selectedId = countryId;
    selectCountry(countryId);
    els.communityInput.value = '';
    setMessage('Added to ' + countryName + '! ✅', 'success');
  } catch (err) {
    setMessage(err.message, 'error');
  } finally {
    els.submitBtn.disabled = false;
  }
});

// ---------------------------------------------------------------------------
// Admin authentication (continent focus is admin-only)
// ---------------------------------------------------------------------------

/** Reflect the current admin state in the UI. */
function setAdmin(isAdmin) {
  state.isAdmin = isAdmin;
  els.mapFocus.hidden = !isAdmin;
  els.adminLoginBtn.hidden = isAdmin;
  els.adminSignedin.hidden = !isAdmin;

  // Leaving admin mode resets any continent focus back to the whole world so
  // participants are never left on a filtered view.
  if (!isAdmin && state.focusContinent) {
    els.continentSelect.value = '';
    focusContinent('');
  }
}

async function refreshSession() {
  try {
    const res = await fetch('/api/session');
    const { admin } = await res.json();
    setAdmin(!!admin);
  } catch (_) {
    setAdmin(false);
  }
}

function openLoginModal() {
  els.loginMessage.textContent = '';
  els.adminPassword.value = '';
  els.loginModal.hidden = false;
  els.adminPassword.focus();
}

function closeLoginModal() {
  els.loginModal.hidden = true;
}

els.adminLoginBtn.addEventListener('click', openLoginModal);
els.loginCancel.addEventListener('click', closeLoginModal);
els.loginModal.addEventListener('click', (e) => {
  if (e.target === els.loginModal) closeLoginModal();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !els.loginModal.hidden) closeLoginModal();
});

els.loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const password = els.adminPassword.value;
  els.loginMessage.textContent = 'Signing in…';
  els.loginMessage.className = 'form-message';
  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    });
    const payload = await res.json();
    if (!res.ok) throw new Error(payload.error || 'Login failed');
    setAdmin(true);
    closeLoginModal();
  } catch (err) {
    els.loginMessage.textContent = err.message;
    els.loginMessage.className = 'form-message error';
  }
});

els.adminLogoutBtn.addEventListener('click', async () => {
  try {
    await fetch('/api/logout', { method: 'POST' });
  } catch (_) {
    /* ignore */
  }
  setAdmin(false);
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function boot() {
  try {
    const [geo, data, continents] = await Promise.all([
      fetch('/data/countries.geo.json').then((r) => r.json()),
      fetchData(),
      fetch('/data/continents.json').then((r) => r.json()),
    ]);
    state.geo = geo;
    state.data = data;
    state.continents = continents;

    renderGeo();
    populateCountrySelect();
    populateContinentSelect();
    renderLabels();
    renderStats();
    updateZoomIndicator();
  } catch (err) {
    setMessage('Could not load the map: ' + err.message, 'error');
    return;
  }

  // Determine whether this visitor is an admin (controls continent focus).
  await refreshSession();

  // Live updates so an audience sees each other's entries appear.
  setInterval(async () => {
    try {
      applyData(await fetchData());
    } catch (_) {
      /* transient network error — keep last known state */
    }
  }, POLL_INTERVAL_MS);
}

boot();
