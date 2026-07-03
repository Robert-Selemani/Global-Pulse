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
  flags: {}, // countryId (ISO A3) -> ISO A2 code for flag images
  focusContinent: '', // '' means whole world
  layersById: {}, // countryId -> Leaflet layer
  selectedId: null,
  isAdmin: false, // continent focus is admin-only
  participantId: null, // stable per-browser id for self-service edit/withdraw
  participationRequired: false, // is a participation code needed to submit?
  participationCode: '', // the code this participant is using
  editingId: null, // submission id currently being edited, or null
};

// A stable identifier per browser so participants can manage their own
// submissions without an account.
function getParticipantId() {
  let id = null;
  try {
    id = localStorage.getItem('gp_participant');
    if (!id) {
      id =
        (crypto.randomUUID && crypto.randomUUID()) ||
        'p-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
      localStorage.setItem('gp_participant', id);
    }
  } catch (_) {
    id = 'p-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
  }
  return id;
}

const SVGNS = 'http://www.w3.org/2000/svg';
const FLAG_BASE = 'https://flagcdn.com';

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
  zoomSlider: document.getElementById('zoom-slider'),
  countrySelect: document.getElementById('country-select'),
  countriesList: document.getElementById('countries-list'),
  countriesTotal: document.getElementById('countries-total'),
  countriesHint: document.getElementById('countries-hint'),
  communityInput: document.getElementById('community-input'),
  form: document.getElementById('entry-form'),
  formTitle: document.getElementById('form-title'),
  submitBtn: document.getElementById('submit-btn'),
  cancelEditBtn: document.getElementById('cancel-edit-btn'),
  formMessage: document.getElementById('form-message'),
  codeField: document.getElementById('code-field'),
  participationInput: document.getElementById('participation-input'),
  // My submissions
  minePanel: document.getElementById('mine-panel'),
  mineList: document.getElementById('mine-list'),
  // Selected-country detail
  clearSelection: document.getElementById('clear-selection'),
  // Admin participation code
  codePanel: document.getElementById('code-panel'),
  codeStatus: document.getElementById('code-status'),
  codeValue: document.getElementById('code-value'),
  qrBox: document.getElementById('qr-box'),
  codeGenerate: document.getElementById('code-generate'),
  codeDisable: document.getElementById('code-disable'),
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
  zoomSnap: 0, // allow smooth, fractional zoom for the custom slider
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
// level) without needing the admin's continent focus. The slider gives a
// custom, continuous percentage rather than fixed steps.
function zoomToPct(zoom) {
  return Math.round((zoom / map.getMinZoom()) * 100);
}
function updateZoomIndicator() {
  const z = map.getZoom();
  els.zoomIndicator.textContent = 'Zoom ' + zoomToPct(z) + '%';
  els.zoomSlider.value = String(z);
}
map.on('zoom zoomend', updateZoomIndicator);
els.zoomSlider.addEventListener('input', () => {
  const z = parseFloat(els.zoomSlider.value);
  els.zoomIndicator.textContent = 'Zoom ' + zoomToPct(z) + '%';
  map.setZoom(z, { animate: false });
});

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

// --- Flag fills -----------------------------------------------------------
// Represented countries are filled with their national flag (instead of a
// flat green). We inject an SVG <pattern> per country into Leaflet's overlay
// SVG and point the country path's fill at it. Using objectBoundingBox units
// means the flag scales with the country automatically on zoom.

function flagUrl(id) {
  const iso2 = state.flags[id];
  return iso2 ? FLAG_BASE + '/w320/' + iso2 + '.png' : null;
}

function patternId(id) {
  return 'flag-' + id;
}

function overlaySvg() {
  return document.querySelector('.leaflet-overlay-pane svg');
}

function ensureDefs() {
  const svg = overlaySvg();
  if (!svg) return null;
  let defs = svg.querySelector('defs.gp-defs');
  if (!defs) {
    defs = document.createElementNS(SVGNS, 'defs');
    defs.setAttribute('class', 'gp-defs');
    svg.insertBefore(defs, svg.firstChild);
  }
  return defs;
}

function ensurePattern(defs, id) {
  const url = flagUrl(id);
  if (!url) return false;
  if (defs.querySelector('#' + patternId(id))) return true;

  const pat = document.createElementNS(SVGNS, 'pattern');
  pat.setAttribute('id', patternId(id));
  pat.setAttribute('patternContentUnits', 'objectBoundingBox');
  pat.setAttribute('width', '1');
  pat.setAttribute('height', '1');

  const img = document.createElementNS(SVGNS, 'image');
  img.setAttribute('width', '1');
  img.setAttribute('height', '1');
  img.setAttribute('preserveAspectRatio', 'xMidYMid slice');
  img.setAttributeNS('http://www.w3.org/1999/xlink', 'href', url);
  img.setAttribute('href', url);

  pat.appendChild(img);
  defs.appendChild(pat);
  return true;
}

/** Point each represented country's fill at its flag pattern. */
function applyFlagFills() {
  const defs = ensureDefs();
  if (!defs) return;
  for (const id of Object.keys(state.layersById)) {
    const layer = state.layersById[id];
    if (!layer || !layer._path) continue;
    const info = state.data.countries[id];
    const active = info && info.totalUsers > 0;
    if (active && inFocus(id) && ensurePattern(defs, id)) {
      layer._path.setAttribute('fill', 'url(#' + patternId(id) + ')');
      layer._path.setAttribute('fill-opacity', id === state.selectedId ? '1' : '0.92');
    }
  }
}

function renderGeo() {
  geoLayer = L.geoJSON(state.geo, {
    style: styleFor,
    onEachFeature: (feature, layer) => {
      state.layersById[feature.id] = layer;
      layer.on('click', () => selectCountry(feature.id));
      layer.on('mouseover', () => {
        layer.setStyle({ weight: 2 });
        layer.bringToFront();
      });
      layer.on('mouseout', () => {
        geoLayer.resetStyle(layer);
        applyFlagFills(); // resetStyle clears the flag fill; restore it
      });
    },
  }).addTo(map);
  applyFlagFills();
}

/**
 * The map shows no numeric labels — represented countries are indicated only
 * by their flag fill. All counts live in the sidebar. Kept as a no-op so the
 * existing call sites stay simple.
 */
function renderLabels() {
  labelLayer.clearLayers();
}

function refreshStyles() {
  if (geoLayer) {
    geoLayer.setStyle(styleFor);
    applyFlagFills(); // setStyle resets fill to a colour; re-assert flags
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
  els.clearSelection.hidden = false;
  refreshStyles();

  const info = state.data.countries[id];
  const name = info
    ? info.name
    : featureName(id) || 'Selected country';

  els.selectedName.textContent = name;

  const layer = state.layersById[id];
  if (layer) map.fitBounds(layer.getBounds(), { maxZoom: 5, padding: [40, 40] });

  renderCommunityList(info);
  renderCountriesList(); // refresh the selected-row highlight
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

/**
 * Always list every represented country with its counts, regardless of which
 * country (if any) is currently selected for entry.
 */
function renderCountriesList() {
  const countries = Object.values(state.data.countries).sort(
    (a, b) => b.totalUsers - a.totalUsers || a.name.localeCompare(b.name)
  );

  els.countriesTotal.textContent = countries.length
    ? countries.length + (countries.length === 1 ? ' country' : ' countries')
    : '';
  els.countriesList.innerHTML = '';

  if (!countries.length) {
    els.countriesHint.style.display = 'block';
    return;
  }
  els.countriesHint.style.display = 'none';

  const frag = document.createDocumentFragment();
  for (const c of countries) {
    const li = document.createElement('li');
    li.className = 'country-row' + (c.id === state.selectedId ? ' selected' : '');
    li.tabIndex = 0;
    li.setAttribute('role', 'button');

    const left = document.createElement('span');
    left.className = 'country-name';
    const iso2 = state.flags[c.id];
    if (iso2) {
      const flag = document.createElement('img');
      flag.className = 'row-flag';
      flag.src = FLAG_BASE + '/24x18/' + iso2 + '.png';
      flag.alt = '';
      flag.loading = 'lazy';
      left.appendChild(flag);
    }
    left.appendChild(document.createTextNode(c.name));

    const right = document.createElement('span');
    right.className = 'country-counts';
    right.innerHTML =
      '<span class="cc-comm">' +
      c.uniqueCommunities +
      (c.uniqueCommunities === 1 ? ' community' : ' communities') +
      '</span><span class="cc-users">' +
      c.totalUsers +
      (c.totalUsers === 1 ? ' participant' : ' participants') +
      '</span>';

    li.appendChild(left);
    li.appendChild(right);
    li.addEventListener('click', () => selectCountry(c.id));
    li.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        selectCountry(c.id);
      }
    });
    frag.appendChild(li);
  }
  els.countriesList.appendChild(frag);
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
  renderCountriesList();
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

  const code = els.participationInput.value.trim();
  if (state.participationRequired && !code) {
    revealCodeField();
    return setMessage('Enter the participation code to continue.', 'error');
  }
  rememberCode(code);

  const editing = state.editingId;
  els.submitBtn.disabled = true;
  setMessage(editing ? 'Updating…' : 'Adding…', '');

  const endpoint = editing ? '/api/submission/' + editing : '/api/submit';
  const method = editing ? 'PUT' : 'POST';

  try {
    const res = await fetch(endpoint, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        countryId,
        countryName,
        community,
        participantId: state.participantId,
        code,
      }),
    });
    const payload = await res.json();
    if (!res.ok) {
      if (payload.code === 'BAD_CODE') revealCodeField();
      throw new Error(payload.error || 'Submission failed');
    }

    applyData(payload.data);
    selectCountry(countryId);
    els.communityInput.value = '';
    await refreshMine();
    if (editing) {
      exitEditMode();
      setMessage('Submission updated ✅', 'success');
    } else {
      setMessage('Added to ' + countryName + '! ✅', 'success');
    }
  } catch (err) {
    setMessage(err.message, 'error');
  } finally {
    els.submitBtn.disabled = false;
  }
});

// ---------------------------------------------------------------------------
// Participation code (participant side)
// ---------------------------------------------------------------------------

function rememberCode(code) {
  state.participationCode = code;
  try {
    if (code) localStorage.setItem('gp_code', code);
  } catch (_) {
    /* ignore */
  }
}

function revealCodeField() {
  els.codeField.hidden = false;
  els.participationInput.focus();
}

function applyParticipationConfig(required) {
  state.participationRequired = required;
  // Show the code field only when a code is required.
  els.codeField.hidden = !required;
}

// ---------------------------------------------------------------------------
// Participant self-service: view / edit / withdraw own submissions
// ---------------------------------------------------------------------------

async function refreshMine() {
  try {
    const res = await fetch('/api/mine?participantId=' + encodeURIComponent(state.participantId));
    const { submissions } = await res.json();
    renderMine(submissions || []);
  } catch (_) {
    /* ignore */
  }
}

function renderMine(subs) {
  els.mineList.innerHTML = '';
  els.minePanel.hidden = subs.length === 0;
  if (!subs.length) return;

  const frag = document.createDocumentFragment();
  for (const s of subs) {
    const li = document.createElement('li');
    li.className = 'mine-row';

    const label = document.createElement('span');
    label.className = 'mine-label';
    const iso2 = state.flags[s.countryId];
    if (iso2) {
      const flag = document.createElement('img');
      flag.className = 'row-flag';
      flag.src = FLAG_BASE + '/24x18/' + iso2 + '.png';
      flag.alt = '';
      label.appendChild(flag);
    }
    label.appendChild(
      document.createTextNode(s.community + ' · ' + s.countryName)
    );

    const actions = document.createElement('span');
    actions.className = 'mine-actions';
    const editBtn = document.createElement('button');
    editBtn.type = 'button';
    editBtn.className = 'mini-btn';
    editBtn.textContent = 'Edit';
    editBtn.addEventListener('click', () => startEdit(s));
    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'mini-btn danger';
    delBtn.textContent = 'Withdraw';
    delBtn.addEventListener('click', () => withdraw(s));
    actions.appendChild(editBtn);
    actions.appendChild(delBtn);

    li.appendChild(label);
    li.appendChild(actions);
    frag.appendChild(li);
  }
  els.mineList.appendChild(frag);
}

function startEdit(sub) {
  state.editingId = sub.id;
  els.countrySelect.value = sub.countryId;
  els.communityInput.value = sub.community;
  els.formTitle.textContent = 'Edit your submission';
  els.submitBtn.textContent = 'Update';
  els.cancelEditBtn.hidden = false;
  selectCountry(sub.countryId);
  els.communityInput.focus();
  setMessage('Editing your submission…', '');
}

function exitEditMode() {
  state.editingId = null;
  els.formTitle.textContent = 'Add your community';
  els.submitBtn.textContent = 'Add to the map';
  els.cancelEditBtn.hidden = true;
  els.communityInput.value = '';
}

els.cancelEditBtn.addEventListener('click', () => {
  exitEditMode();
  setMessage('', '');
});

async function withdraw(sub) {
  if (!window.confirm('Withdraw your submission "' + sub.community + '"?')) return;
  try {
    const res = await fetch(
      '/api/submission/' +
        sub.id +
        '?participantId=' +
        encodeURIComponent(state.participantId),
      { method: 'DELETE' }
    );
    const payload = await res.json();
    if (!res.ok) throw new Error(payload.error || 'Could not withdraw');
    if (state.editingId === sub.id) exitEditMode();
    applyData(payload.data);
    await refreshMine();
    setMessage('Submission withdrawn.', 'success');
  } catch (err) {
    setMessage(err.message, 'error');
  }
}

// ---------------------------------------------------------------------------
// Clear selection
// ---------------------------------------------------------------------------

function clearSelection() {
  state.selectedId = null;
  els.countrySelect.value = '';
  els.clearSelection.hidden = true;
  els.selectedName.textContent = 'Select a country';
  els.selectedCount.textContent = '';
  els.communityHint.style.display = 'block';
  els.communityHint.textContent =
    'Click a country on the map, or pick one above, to see its communities.';
  els.communityList.innerHTML = '';
  refreshStyles();
  renderCountriesList();
}

els.clearSelection.addEventListener('click', clearSelection);

// ---------------------------------------------------------------------------
// Admin authentication (continent focus is admin-only)
// ---------------------------------------------------------------------------

/** Reflect the current admin state in the UI. */
function setAdmin(isAdmin) {
  state.isAdmin = isAdmin;
  els.mapFocus.hidden = !isAdmin;
  els.adminLoginBtn.hidden = isAdmin;
  els.adminSignedin.hidden = !isAdmin;
  els.codePanel.hidden = !isAdmin;
  if (isAdmin) loadAdminCode();

  // Leaving admin mode resets any continent focus back to the whole world so
  // participants are never left on a filtered view.
  if (!isAdmin && state.focusContinent) {
    els.continentSelect.value = '';
    focusContinent('');
  }
}

// ---------------------------------------------------------------------------
// Admin: participation code + QR
// ---------------------------------------------------------------------------

/** Render a QR code (as an <img>) for the given text into a container. */
function renderQr(container, text) {
  container.innerHTML = '';
  try {
    const qr = qrcode(0, 'M'); // type 0 = auto-size, medium error correction
    qr.addData(text);
    qr.make();
    container.innerHTML = qr.createImgTag(5, 8); // cellSize, margin
    const img = container.querySelector('img');
    if (img) img.alt = 'QR code to join';
  } catch (_) {
    container.textContent = text;
  }
}

function joinUrl(code) {
  return location.origin + '/?code=' + encodeURIComponent(code);
}

function renderAdminCode(code) {
  if (code) {
    els.codeStatus.textContent = 'Attendees enter this code (or scan the QR) to participate:';
    els.codeValue.textContent = code;
    els.codeValue.hidden = false;
    els.qrBox.hidden = false;
    renderQr(els.qrBox, joinUrl(code));
    els.codeDisable.hidden = false;
    els.codeGenerate.textContent = 'Regenerate code';
  } else {
    els.codeStatus.textContent = 'No code set — participation is open to everyone.';
    els.codeValue.hidden = true;
    els.qrBox.hidden = true;
    els.qrBox.innerHTML = '';
    els.codeDisable.hidden = true;
    els.codeGenerate.textContent = 'Generate code';
  }
}

async function loadAdminCode() {
  try {
    const res = await fetch('/api/admin/code');
    if (!res.ok) return;
    const { code } = await res.json();
    renderAdminCode(code);
  } catch (_) {
    /* ignore */
  }
}

els.codeGenerate.addEventListener('click', async () => {
  els.codeGenerate.disabled = true;
  try {
    const res = await fetch('/api/admin/code', { method: 'POST' });
    const { code } = await res.json();
    renderAdminCode(code);
    state.participationRequired = true;
  } catch (_) {
    /* ignore */
  } finally {
    els.codeGenerate.disabled = false;
  }
});

els.codeDisable.addEventListener('click', async () => {
  if (!window.confirm('Disable the participation code? Anyone will be able to participate.'))
    return;
  try {
    await fetch('/api/admin/code', { method: 'DELETE' });
    renderAdminCode(null);
    state.participationRequired = false;
    applyParticipationConfig(false);
  } catch (_) {
    /* ignore */
  }
});

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
    const [geo, data, continents, flags] = await Promise.all([
      fetch('/data/countries.geo.json').then((r) => r.json()),
      fetchData(),
      fetch('/data/continents.json').then((r) => r.json()),
      fetch('/data/flags.json').then((r) => r.json()),
    ]);
    state.geo = geo;
    state.data = data;
    state.continents = continents;
    state.flags = flags;

    renderGeo();
    populateCountrySelect();
    populateContinentSelect();
    renderLabels();
    renderStats();
    renderCountriesList();
    updateZoomIndicator();
  } catch (err) {
    setMessage('Could not load the map: ' + err.message, 'error');
    return;
  }

  // Identify this browser for self-service edit/withdraw.
  state.participantId = getParticipantId();

  // Seed the participation code from the URL (?code= from a scanned QR) or from
  // a previous session, then learn whether a code is currently required.
  const urlCode = new URLSearchParams(location.search).get('code');
  let savedCode = '';
  try {
    savedCode = urlCode || localStorage.getItem('gp_code') || '';
  } catch (_) {
    savedCode = urlCode || '';
  }
  if (savedCode) {
    els.participationInput.value = savedCode.trim();
    rememberCode(savedCode.trim());
  }
  try {
    const cfg = await fetch('/api/config').then((r) => r.json());
    applyParticipationConfig(!!cfg.participationRequired);
  } catch (_) {
    /* ignore */
  }

  // Determine whether this visitor is an admin (controls continent focus).
  await refreshSession();

  // Load this participant's own submissions (edit/withdraw list).
  await refreshMine();

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
