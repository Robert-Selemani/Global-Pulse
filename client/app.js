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
  layersById: {}, // countryId -> Leaflet layer
  selectedId: null,
};

const els = {
  map: document.getElementById('map'),
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

function styleFor(feature) {
  const info = state.data.countries[feature.id];
  const base = info && info.totalUsers > 0 ? STYLE_ACTIVE : STYLE_INACTIVE;
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
// Boot
// ---------------------------------------------------------------------------

async function boot() {
  try {
    const [geo, data] = await Promise.all([
      fetch('/data/countries.geo.json').then((r) => r.json()),
      fetchData(),
    ]);
    state.geo = geo;
    state.data = data;

    renderGeo();
    populateCountrySelect();
    renderLabels();
    renderStats();
  } catch (err) {
    setMessage('Could not load the map: ' + err.message, 'error');
    return;
  }

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
