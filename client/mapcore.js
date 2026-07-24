/* global L */
'use strict';

/**
 * Shared map + rendering core, used by both the presentation page and the
 * voting page. Exposed as window.GP. Voting-only UI (entry form, self-service,
 * participation code, account menu) lives in vote.js; the presentation page
 * uses this core read-only.
 *
 * All element lookups are guarded so a page can omit any of them.
 */
window.GP = (function () {
  const POLL_INTERVAL_MS = 4000;
  const SVGNS = 'http://www.w3.org/2000/svg';
  const FLAG_BASE = 'https://flagcdn.com';
  const CONTINENTS = [
    'Africa',
    'Asia',
    'Europe',
    'North America',
    'South America',
    'Oceania',
    'Antarctica',
  ];

  const state = {
    data: { countries: {}, totals: {} },
    geo: null,
    continents: {},
    flags: {},
    focusContinent: '',
    layersById: {},
    selectedId: null,
  };

  const $ = (id) => document.getElementById(id);
  const els = {
    mapFocus: $('map-focus'),
    continentSelect: $('continent-select'),
    zoomIndicator: $('zoom-indicator'),
    zoomSlider: $('zoom-slider'),
    countrySelect: $('country-select'),
    countriesList: $('countries-list'),
    countriesTotal: $('countries-total'),
    countriesHint: $('countries-hint'),
    selectedName: $('selected-country-name'),
    selectedCount: $('selected-country-count'),
    communityHint: $('community-hint'),
    communityList: $('community-list'),
    clearSelection: $('clear-selection'),
    statCountries: $('stat-countries'),
    statCommunities: $('stat-communities'),
    statUsers: $('stat-users'),
  };

  let map;
  let labelLayer;
  let geoLayer = null;
  let selectHandler = null;
  let dataHandler = null;

  // --- Zoom -----------------------------------------------------------------
  function zoomToPct(zoom) {
    return Math.round((zoom / map.getMinZoom()) * 100);
  }
  function updateZoomIndicator() {
    if (!map) return;
    const z = map.getZoom();
    if (els.zoomIndicator) els.zoomIndicator.textContent = 'Zoom ' + zoomToPct(z) + '%';
    if (els.zoomSlider) els.zoomSlider.value = String(z);
  }

  // --- Styles ---------------------------------------------------------------
  // Land sits on a solid ocean (no raster tiles), so fills are near-opaque and
  // borders are thin for a clean, smooth look at world scale.
  const STYLE_INACTIVE = { fillColor: '#3c5474', fillOpacity: 0.92, color: '#22344c', weight: 0.6 };
  const STYLE_ACTIVE = { fillColor: '#2fd27a', fillOpacity: 0.85, color: '#0f7a45', weight: 0.8 };
  const STYLE_SELECTED = { color: '#ffffff', weight: 2 };
  const STYLE_DIMMED = { fillOpacity: 0.12, opacity: 0.25 };

  function inFocus(id) {
    return !state.focusContinent || state.continents[id] === state.focusContinent;
  }
  function styleFor(feature) {
    const info = state.data.countries[feature.id];
    const base = info && info.totalUsers > 0 ? STYLE_ACTIVE : STYLE_INACTIVE;
    if (!inFocus(feature.id)) return Object.assign({}, base, STYLE_DIMMED);
    if (feature.id === state.selectedId) return Object.assign({}, base, STYLE_SELECTED);
    return base;
  }

  // --- Flag fills -----------------------------------------------------------
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

  // --- Rendering ------------------------------------------------------------
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
          applyFlagFills();
        });
      },
    }).addTo(map);
    applyFlagFills();
  }
  function renderLabels() {
    if (labelLayer) labelLayer.clearLayers(); // map shows no numbers
  }
  function refreshStyles() {
    if (geoLayer) {
      geoLayer.setStyle(styleFor);
      applyFlagFills();
    }
  }

  function featureName(id) {
    const f = state.geo.features.find((x) => x.id === id);
    return f ? f.properties.name : '';
  }

  function selectCountry(id) {
    state.selectedId = id;
    if (els.countrySelect) els.countrySelect.value = id;
    if (els.clearSelection) els.clearSelection.hidden = false;
    refreshStyles();

    const info = state.data.countries[id];
    const name = info ? info.name : featureName(id) || 'Selected country';
    if (els.selectedName) els.selectedName.textContent = name;

    const layer = state.layersById[id];
    if (layer) map.fitBounds(layer.getBounds(), { maxZoom: 5, padding: [40, 40] });

    renderCommunityList(info);
    renderCountriesList();
    if (selectHandler) selectHandler(id);
  }

  function clearSelection() {
    state.selectedId = null;
    if (els.countrySelect) els.countrySelect.value = '';
    if (els.clearSelection) els.clearSelection.hidden = true;
    if (els.selectedName) els.selectedName.textContent = 'Select a country';
    if (els.selectedCount) els.selectedCount.textContent = '';
    if (els.communityHint) {
      els.communityHint.style.display = 'block';
      els.communityHint.textContent =
        'Click a country on the map to see its communities.';
    }
    if (els.communityList) els.communityList.innerHTML = '';
    refreshStyles();
    renderCountriesList();
  }

  function renderCommunityList(info) {
    if (!els.communityList) return;
    els.communityList.innerHTML = '';
    if (!info || !info.communities.length) {
      if (els.selectedCount) els.selectedCount.textContent = '';
      if (els.communityHint) {
        els.communityHint.style.display = 'block';
        els.communityHint.textContent = 'No communities here yet.';
      }
      return;
    }
    if (els.communityHint) els.communityHint.style.display = 'none';
    if (els.selectedCount) {
      els.selectedCount.textContent =
        info.uniqueCommunities + (info.uniqueCommunities === 1 ? ' community' : ' communities');
    }
    const frag = document.createDocumentFragment();
    for (const c of info.communities) {
      const li = document.createElement('li');
      const nameSpan = document.createElement('span');
      nameSpan.className = 'c-name';
      nameSpan.textContent = c.name;
      const countSpan = document.createElement('span');
      countSpan.className = 'c-count';
      countSpan.textContent = c.count + (c.count === 1 ? ' member' : ' members');
      li.appendChild(nameSpan);
      li.appendChild(countSpan);
      frag.appendChild(li);
    }
    els.communityList.appendChild(frag);
  }

  function renderCountriesList() {
    if (!els.countriesList) return;
    const countries = Object.values(state.data.countries).sort(
      (a, b) => b.totalUsers - a.totalUsers || a.name.localeCompare(b.name)
    );
    if (els.countriesTotal) {
      els.countriesTotal.textContent = countries.length
        ? countries.length + (countries.length === 1 ? ' country' : ' countries')
        : '';
    }
    els.countriesList.innerHTML = '';
    if (!countries.length) {
      if (els.countriesHint) els.countriesHint.style.display = 'block';
      return;
    }
    if (els.countriesHint) els.countriesHint.style.display = 'none';
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

  function renderStats() {
    const t = state.data.totals || {};
    if (els.statCountries) els.statCountries.textContent = t.activeCountries || 0;
    if (els.statCommunities) els.statCommunities.textContent = t.totalCommunities || 0;
    if (els.statUsers) els.statUsers.textContent = t.totalUsers || 0;
  }

  // --- Country picker -------------------------------------------------------
  /**
   * Fill the entry form's country dropdown from the loaded geometry. Each
   * option carries the feature id as its value and the display name as
   * data-name, which vote.js reads on submit. Guarded so the presentation
   * page (which has no dropdown) is unaffected.
   */
  function populateCountrySelect() {
    if (!els.countrySelect) return;
    const feats = state.geo.features
      .filter((f) => f.id && f.properties && f.properties.name)
      .sort((a, b) => a.properties.name.localeCompare(b.properties.name));
    const frag = document.createDocumentFragment();
    for (const f of feats) {
      const opt = document.createElement('option');
      opt.value = f.id;
      opt.dataset.name = f.properties.name;
      opt.textContent = f.properties.name;
      frag.appendChild(opt);
    }
    els.countrySelect.appendChild(frag);
  }

  // --- Continent focus (admin) ---------------------------------------------
  function populateContinentSelect() {
    if (!els.continentSelect) return;
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
    els.continentSelect.addEventListener('change', () => focusContinent(els.continentSelect.value));
  }

  function focusContinent(name) {
    state.focusContinent = name;
    refreshStyles();
    renderLabels();
    if (els.countrySelect) {
      for (const opt of els.countrySelect.options) {
        if (!opt.value) continue;
        opt.hidden = !!name && state.continents[opt.value] !== name;
      }
      if (name && state.continents[els.countrySelect.value] !== name) {
        els.countrySelect.value = '';
      }
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
    if (bounds.isValid()) map.fitBounds(bounds, { padding: [30, 30], maxZoom: 5 });
  }

  // --- Data flow ------------------------------------------------------------
  // The data endpoint is configurable so a page can scope the map to one poll
  // (e.g. '/api/poll/<slug>/data'). Defaults to the legacy global alias.
  let dataUrl = '/api/data';
  function setDataUrl(url) {
    if (url) dataUrl = url;
  }
  async function fetchData() {
    const res = await fetch(dataUrl);
    if (!res.ok) throw new Error('Failed to load data');
    return res.json();
  }
  function applyData(data) {
    state.data = data;
    refreshStyles();
    renderLabels();
    renderStats();
    renderCountriesList();
    if (state.selectedId) renderCommunityList(state.data.countries[state.selectedId]);
    if (dataHandler) dataHandler(state.data);
  }

  async function loadStatic() {
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
  }

  function initMap() {
    map = L.map('map', {
      center: [20, 10],
      zoom: 2,
      minZoom: 2,
      maxZoom: 6,
      zoomSnap: 0,
      worldCopyJump: true,
      attributionControl: false,
    });
    // No raster basemap: a solid ocean (the #map background) keeps borders
    // crisp and seam-free, and removes an external tile dependency.
    labelLayer = L.layerGroup().addTo(map);
    map.on('zoom zoomend', updateZoomIndicator);
    if (els.zoomSlider) {
      els.zoomSlider.addEventListener('input', () => {
        const z = parseFloat(els.zoomSlider.value);
        if (els.zoomIndicator) els.zoomIndicator.textContent = 'Zoom ' + zoomToPct(z) + '%';
        map.setZoom(z, { animate: false });
      });
    }
    if (els.clearSelection) els.clearSelection.addEventListener('click', clearSelection);
    return map;
  }

  /** Load everything and render. Returns once the initial paint is done. */
  async function boot() {
    await loadStatic();
    renderGeo();
    populateCountrySelect();
    populateContinentSelect();
    renderStats();
    renderCountriesList();
    updateZoomIndicator();
    if (dataHandler) dataHandler(state.data);
  }

  function startPolling() {
    setInterval(async () => {
      try {
        applyData(await fetchData());
      } catch (_) {
        /* keep last known state */
      }
    }, POLL_INTERVAL_MS);
  }

  return {
    state,
    els,
    FLAG_BASE,
    setDataUrl,
    initMap,
    boot,
    startPolling,
    applyData,
    selectCountry,
    clearSelection,
    focusContinent,
    renderCountriesList,
    renderCommunityList,
    refreshStyles,
    onSelect(fn) {
      selectHandler = fn;
    },
    onData(fn) {
      dataHandler = fn;
    },
  };
})();
