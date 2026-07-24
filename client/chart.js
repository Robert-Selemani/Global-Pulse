'use strict';

/**
 * Communities-by-country bar chart for the results/presentation page.
 *
 * A single-series magnitude chart: one bar per represented country, its height
 * the number of distinct communities in that country. Dependency-free inline
 * SVG (CSP-safe, no CDN), themed from the same CSS variables as the rest of the
 * app, and re-rendered live from the GP data feed.
 *
 * Exposed as window.GPChart with render(data), where `data` is the aggregate
 * shape from /api/.../data: { countries: { <id>: { name, uniqueCommunities,
 * totalUsers, ... } }, totals: {...} }.
 */
window.GPChart = (function () {
  const SVGNS = 'http://www.w3.org/2000/svg';

  // Layout constants (SVG user units == px; the svg scales to its container).
  const PAD = { top: 24, right: 16, bottom: 84, left: 40 };
  const PLOT_H = 240; // height of the plotting area
  const BAR_SLOT = 64; // horizontal space per country (bar + gutter)
  const BAR_MAX_W = 44; // cap bar width so few-country charts don't look blocky
  const BAR_GAP = 2; // surface gap the design system asks for between fills

  let root = null; // the container element
  let tip = null; // hover tooltip element

  function el(name, attrs) {
    const node = document.createElementNS(SVGNS, name);
    if (attrs) for (const k of Object.keys(attrs)) node.setAttribute(k, attrs[k]);
    return node;
  }

  /** "Nice" integer tick step so the y-axis reads in whole communities. */
  function niceTicks(max) {
    const target = 4; // aim for ~4 gridlines
    if (max <= 1) return [0, 1];
    const raw = max / target;
    const pow = Math.pow(10, Math.floor(Math.log10(raw)));
    const candidates = [1, 2, 5, 10].map((m) => m * pow);
    let step = candidates.find((c) => c >= raw) || candidates[candidates.length - 1];
    step = Math.max(1, Math.round(step)); // counts are integers
    const ticks = [];
    for (let v = 0; v <= max; v += step) ticks.push(v);
    if (ticks[ticks.length - 1] !== max) ticks.push(ticks[ticks.length - 1] + step);
    return ticks;
  }

  function ensureTip() {
    if (tip) return tip;
    tip = document.createElement('div');
    tip.className = 'gp-chart-tip';
    tip.setAttribute('role', 'status');
    tip.hidden = true;
    root.appendChild(tip);
    return tip;
  }

  function showTip(evt, c) {
    ensureTip();
    tip.innerHTML =
      '<strong>' +
      escapeHtml(c.name) +
      '</strong>' +
      c.uniqueCommunities +
      (c.uniqueCommunities === 1 ? ' community' : ' communities') +
      ' · ' +
      c.totalUsers +
      (c.totalUsers === 1 ? ' participant' : ' participants');
    tip.hidden = false;
    const rect = root.getBoundingClientRect();
    const x = evt.clientX - rect.left;
    const y = evt.clientY - rect.top;
    // Keep the tooltip inside the panel horizontally.
    tip.style.left = Math.min(Math.max(x, 8), rect.width - 8) + 'px';
    tip.style.top = Math.max(y - 12, 8) + 'px';
  }
  function hideTip() {
    if (tip) tip.hidden = true;
  }

  function escapeHtml(s) {
    return String(s).replace(
      /[&<>"']/g,
      (ch) =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch])
    );
  }

  function mount(container) {
    root = container;
  }

  function render(data) {
    if (!root) return;
    const countries = Object.values((data && data.countries) || {})
      .filter((c) => c.uniqueCommunities > 0)
      .sort(
        (a, b) => b.uniqueCommunities - a.uniqueCommunities || a.name.localeCompare(b.name)
      );

    // Clear previous SVG (keep the tooltip element).
    const old = root.querySelector('svg.gp-chart-svg');
    if (old) old.remove();
    let empty = root.querySelector('.gp-chart-empty');

    if (!countries.length) {
      hideTip();
      if (!empty) {
        empty = document.createElement('p');
        empty.className = 'gp-chart-empty hint';
        empty.textContent = 'No communities yet — the chart appears once entries arrive.';
        root.appendChild(empty);
      }
      return;
    }
    if (empty) empty.remove();

    const max = countries.reduce((m, c) => Math.max(m, c.uniqueCommunities), 0);
    const ticks = niceTicks(max);
    const yMax = ticks[ticks.length - 1] || 1;

    const plotW = countries.length * BAR_SLOT;
    const width = PAD.left + plotW + PAD.right;
    const height = PAD.top + PLOT_H + PAD.bottom;
    const yOf = (v) => PAD.top + PLOT_H - (v / yMax) * PLOT_H;

    const svg = el('svg', {
      class: 'gp-chart-svg',
      viewBox: '0 0 ' + width + ' ' + height,
      width: width,
      height: height,
      role: 'img',
      'aria-label': 'Bar chart of the number of communities per country',
    });

    // --- Y grid + ticks (recessive) ---
    for (const t of ticks) {
      const y = yOf(t);
      svg.appendChild(
        el('line', {
          x1: PAD.left,
          y1: y,
          x2: PAD.left + plotW,
          y2: y,
          class: 'gp-grid',
        })
      );
      const label = el('text', { x: PAD.left - 8, y: y + 4, class: 'gp-axis-label gp-y' });
      label.textContent = String(t);
      svg.appendChild(label);
    }

    // --- Bars + x labels + value labels ---
    const barW = Math.min(BAR_MAX_W, BAR_SLOT - 20);
    countries.forEach((c, i) => {
      const cx = PAD.left + i * BAR_SLOT + BAR_SLOT / 2;
      const x = cx - barW / 2;
      const top = yOf(c.uniqueCommunities);
      const h = Math.max(2, PAD.top + PLOT_H - top - BAR_GAP);

      const bar = el('rect', {
        x: x,
        y: top,
        width: barW,
        height: h,
        rx: 4, // rounded data-end
        ry: 4,
        class: 'gp-bar',
      });
      bar.addEventListener('mousemove', (e) => showTip(e, c));
      bar.addEventListener('mouseenter', (e) => showTip(e, c));
      bar.addEventListener('mouseleave', hideTip);
      svg.appendChild(bar);

      // Value label above each bar (few bars → direct labels aid reading).
      const val = el('text', { x: cx, y: top - 8, class: 'gp-value-label' });
      val.textContent = String(c.uniqueCommunities);
      svg.appendChild(val);

      // X-axis country label, rotated to avoid collisions.
      const name = c.name.length > 16 ? c.name.slice(0, 15) + '…' : c.name;
      const xl = el('text', {
        x: cx,
        y: PAD.top + PLOT_H + 16,
        class: 'gp-axis-label gp-x',
        transform: 'rotate(-40 ' + cx + ' ' + (PAD.top + PLOT_H + 16) + ')',
      });
      xl.textContent = name;
      const title = el('title');
      title.textContent = c.name;
      xl.appendChild(title);
      svg.appendChild(xl);
    });

    // --- Baseline + axis titles ---
    svg.appendChild(
      el('line', {
        x1: PAD.left,
        y1: PAD.top + PLOT_H,
        x2: PAD.left + plotW,
        y2: PAD.top + PLOT_H,
        class: 'gp-axis',
      })
    );

    root.insertBefore(svg, root.firstChild);
  }

  return { mount, render };
})();
