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
  const FLAG_BASE = '/vendor/flags'; // bundled locally - no external CDN
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
    focusContinent: '', // what the map is currently showing
    pollContinent: '', // the poll's pinned continent, '' when unpinned
    layersById: {},
    selectedId: null,
  };

  // Breathing room left around a focused continent, as a share of the panel
  // (Leaflet's padding is the total across both sides, so this is half that
  // at each edge). Enough that the coast is not touching the frame.
  const FRAME_MARGIN = 0.09;

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
  let resizeBound = false;

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
    return iso2 ? FLAG_BASE + '/' + iso2 + '.png' : null;
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
    // Accent-coloured backing so a country still reads as "represented" if its
    // flag image is slow or unavailable, instead of showing a transparent hole.
    const rect = document.createElementNS(SVGNS, 'rect');
    rect.setAttribute('width', '1');
    rect.setAttribute('height', '1');
    rect.setAttribute('fill', '#2fd27a');
    pat.appendChild(rect);
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
        flag.src = FLAG_BASE + '/' + iso2 + '.png';
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

  // The presentation page animates these counters itself (count-up), so it can
  // opt out of the plain text writes here via useExternalStats().
  let externalStats = false;
  function renderStats() {
    if (externalStats) return;
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
    // A poll pinned to a continent offers only that continent's countries.
    const feats = state.geo.features
      .filter((f) => f.id && f.properties && f.properties.name)
      .filter((f) => !state.pollContinent || state.continents[f.id] === state.pollContinent)
      .sort((a, b) => a.properties.name.localeCompare(b.properties.name));
    // Keep the placeholder, replace the country options.
    for (const opt of Array.from(els.countrySelect.options)) {
      if (opt.value) opt.remove();
    }
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


  /**
   * A country's principal landmass, measured in two longitude frames: as-is,
   * and with negatives shifted east by 360.
   *
   * Principal, because a country's outlying specks are not where its map
   * belongs: South Africa's sub-Antarctic islands sit 12 degrees below the
   * mainland, France's departments reach the Amazon, Portugal's reach the
   * mid-Atlantic. Two frames, because Oceania and North America straddle the
   * antimeridian, where an as-is box runs the long way round the globe.
   */
  function principalBox(feature) {
    const g = feature.geometry;
    if (!g) return null;
    const polys =
      g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
    let best = null;
    for (const poly of polys) {
      const ring = poly[0];
      if (!ring || !ring.length) continue;
      let south = Infinity;
      let north = -Infinity;
      let west = Infinity;
      let east = -Infinity;
      let westShifted = Infinity;
      let eastShifted = -Infinity;
      for (const [x, y] of ring) {
        if (y < south) south = y;
        if (y > north) north = y;
        if (x < west) west = x;
        if (x > east) east = x;
        const shifted = x < 0 ? x + 360 : x;
        if (shifted < westShifted) westShifted = shifted;
        if (shifted > eastShifted) eastShifted = shifted;
      }
      // Width in whichever frame keeps the polygon whole, so a country that
      // crosses the line is not measured as if it spanned the planet.
      const width = Math.min(east - west, eastShifted - westShifted);
      const area = width * (north - south);
      if (!best || area > best.area) {
        best = { south, north, raw: [west, east], shifted: [westShifted, eastShifted], area };
      }
    }
    return best;
  }

  /** Drop values lying more than 1.5 IQR outside the quartiles (Tukey). */
  function inlierRange(values) {
    const sorted = values.slice().sort((a, b) => a - b);
    const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * (sorted.length - 1)))];
    const q1 = at(0.25);
    const q3 = at(0.75);
    const slack = 1.5 * (q3 - q1);
    return [q1 - slack, q3 + slack];
  }

  /**
   * Lat/lng bounds framing a continent.
   *
   * Built from the countries that sit with the rest of the group, so one
   * far-flung member cannot drag the frame across the globe: continents.json
   * files Russia under Europe, and its Pacific coast would otherwise stretch
   * a "Europe" poll from the Atlantic to Chukotka, leaving Europe itself a
   * sliver at the edge.
   */
  function continentBounds(name) {
    const boxes = [];
    for (const feature of state.geo.features) {
      if (state.continents[feature.id] !== name) continue;
      const box = principalBox(feature);
      if (box) boxes.push(box);
    }
    if (!boxes.length) return L.latLngBounds([]);

    const span = (key) =>
      Math.max.apply(null, boxes.map((b) => b[key][1])) -
      Math.min.apply(null, boxes.map((b) => b[key][0]));
    const key = span('shifted') < span('raw') ? 'shifted' : 'raw';

    const midLon = (b) => (b[key][0] + b[key][1]) / 2;
    const midLat = (b) => (b.south + b.north) / 2;
    const lonRange = inlierRange(boxes.map(midLon));
    const latRange = inlierRange(boxes.map(midLat));
    const kept = boxes.filter(
      (b) =>
        midLon(b) >= lonRange[0] &&
        midLon(b) <= lonRange[1] &&
        midLat(b) >= latRange[0] &&
        midLat(b) <= latRange[1]
    );

    const bounds = L.latLngBounds([]);
    for (const b of kept.length ? kept : boxes) {
      bounds.extend([[b.south, b[key][0]], [b.north, b[key][1]]]);
    }
    return bounds;
  }

  /**
   * Put the whole region on screen, centred, as large as it will go.
   *
   * The region is sized to fit inside the panel rather than to cover it: a
   * cover crops whatever does not match the panel's shape, which quietly took
   * the top off Africa and pushed the far ends of Asia out of view. Fitting
   * keeps every country a participant can pick on screen and leaves the map
   * sitting square in its panel, with nothing to zoom.
   *
   * invalidateSize() first because the panel is often still being laid out
   * when this runs (flex/grid on load, or an orientation change).
   */
  function fillWithContinent(name) {
    if (!map || !name) return;
    map.invalidateSize({ animate: false });
    const bounds = continentBounds(name);
    if (!bounds.isValid()) return;
    // A little air on each side so the coastline is not flush against the
    // panel edge.
    const size = map.getSize();
    const pad = L.point(size.x * FRAME_MARGIN, size.y * FRAME_MARGIN);
    const z = Math.min(map.getBoundsZoom(bounds, false, pad), map.getMaxZoom());
    // Centre on the middle of the projected box, not on bounds.getCenter():
    // Mercator stretches high latitudes, so the lat/lng midpoint of a region
    // like Africa sits well below its pixel midpoint and the region would sit
    // low in the panel (~60px on a tall one).
    const nw = map.project(bounds.getNorthWest(), z);
    const se = map.project(bounds.getSouthEast(), z);
    // wrapLatLng because a straddling continent is measured in a shifted
    // frame (e.g. centre 269E for North America). Leaflet draws vector layers
    // in one world copy only, so an unwrapped centre shows blank ocean.
    const centre = map.wrapLatLng(map.unproject(nw.add(se).divideBy(2), z));
    map.setView(centre, z, { animate: false });
    applyFlagFills();
  }

  function focusContinent(name) {
    state.focusContinent = name;
    refreshStyles();
    renderLabels();
    // Only an unpinned poll lets the view narrow the country choices; when the
    // poll owns the focus, the dropdown stays fixed to the poll's continent.
    if (els.countrySelect && !state.pollContinent) {
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
    fillWithContinent(name);
  }

  /**
   * Pin the poll to one continent: the join form offers only its countries and
   * both maps open filled with the region. Call after boot(), once the geometry
   * and the map panel exist.
   */
  function setPollContinent(name) {
    const continent = name && CONTINENTS.includes(name) ? name : '';
    state.pollContinent = continent;
    populateCountrySelect();
    if (!continent) return;
    if (els.continentSelect) els.continentSelect.value = continent;
    focusContinent(continent);
    // The panel can still be settling (fonts, the phone's flex column, a
    // rotation): re-fill on the next frame and whenever the box changes size.
    requestAnimationFrame(() => fillWithContinent(state.focusContinent || continent));
    if (!resizeBound) {
      resizeBound = true;
      window.addEventListener('resize', () => {
        if (state.focusContinent) fillWithContinent(state.focusContinent);
      });
    }
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
      // Headroom above the old cap of 6 so a compact continent can still fill
      // a narrow panel (a phone map needs ~7 to cover Europe edge to edge).
      maxZoom: 9,
      zoomSnap: 0,
      worldCopyJump: true,
      attributionControl: false,
    });
    // No raster basemap: a solid ocean (the #map background) keeps borders
    // crisp and seam-free, and removes an external tile dependency.
    labelLayer = L.layerGroup().addTo(map);
    map.on('zoom zoomend', updateZoomIndicator);
    // Re-assert flag fills after a zoom/pan (e.g. focusing a continent) so the
    // flags reliably repaint on the represented countries.
    map.on('zoomend moveend', applyFlagFills);
    if (els.zoomSlider) {
      // Keep the slider's range honest about what the map allows.
      els.zoomSlider.min = String(map.getMinZoom());
      els.zoomSlider.max = String(map.getMaxZoom());
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
    getMap: () => map,
    boot,
    startPolling,
    applyData,
    selectCountry,
    clearSelection,
    focusContinent,
    setPollContinent,
    renderCountriesList,
    renderCommunityList,
    refreshStyles,
    // Let the caller own the header stat numbers (for count-up animation).
    useExternalStats() {
      externalStats = true;
    },
    // Briefly flash a country on the map (e.g. when a new entry lands there).
    pulseCountry(id) {
      const layer = state.layersById[id];
      const path = layer && layer._path;
      if (!path) return;
      path.classList.remove('gp-pulse');
      // Force reflow so the animation restarts if the country pulses again.
      void path.getBoundingClientRect();
      path.classList.add('gp-pulse');
      setTimeout(() => path.classList.remove('gp-pulse'), 1500);
    },
    onSelect(fn) {
      selectHandler = fn;
    },
    onData(fn) {
      dataHandler = fn;
    },
  };
})();
