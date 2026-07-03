'use strict';

/**
 * Global Pulse - Interactive Community Map
 *
 * A zero-dependency Node.js HTTP server that powers the community
 * visualization tool described in the Software Functionality Document.
 * It exposes a small JSON API and serves the static client.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const PORT = process.env.PORT || 3000;
const CLIENT_DIR = path.join(__dirname, '..', 'client');

// Submissions are persisted here. On Render, DATA_DIR points at a mounted
// persistent disk (e.g. /var/data) so data survives deploys and restarts.
// Locally it defaults to the server directory.
const DATA_DIR = process.env.DATA_DIR || __dirname;
const DATA_FILE = path.join(DATA_DIR, 'data.json');

try {
  fs.mkdirSync(DATA_DIR, { recursive: true });
} catch (err) {
  // eslint-disable-next-line no-console
  console.error('Could not create data directory ' + DATA_DIR + ':', err.message);
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

/**
 * Submissions are stored as a flat list of records. Aggregation into
 * per-country / per-community counts happens on read. This keeps the raw
 * data intact so normalization rules can evolve without losing information.
 *
 * Record shape: { countryId, countryName, community, normalized, ts }
 */
function loadSubmissions() {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed.submissions) ? parsed.submissions : [];
  } catch (err) {
    return [];
  }
}

function saveSubmissions(submissions) {
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ submissions }, null, 2));
  fs.renameSync(tmp, DATA_FILE); // atomic write
}

let submissions = loadSubmissions();

// ---------------------------------------------------------------------------
// Normalization & deduplication
// ---------------------------------------------------------------------------

/**
 * Produce a canonical key for a community name so that variants such as
 * "AI Eswatini", "ai eswatini", and " ai-eswatini! " all collapse to a
 * single unique community. Rules: lowercase, strip accents, remove
 * punctuation, and collapse whitespace.
 */
function normalizeCommunity(name) {
  return String(name)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // strip diacritics
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ') // drop punctuation/symbols
    .replace(/\s+/g, ' ')
    .trim();
}

/** Tidy the user-facing display name without changing its identity. */
function cleanDisplay(name) {
  return String(name).replace(/\s+/g, ' ').trim();
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

function aggregate() {
  const countries = {};

  for (const rec of submissions) {
    if (!rec.countryId) continue;
    let country = countries[rec.countryId];
    if (!country) {
      country = countries[rec.countryId] = {
        id: rec.countryId,
        name: rec.countryName,
        totalUsers: 0,
        communities: {}, // normalized -> { name, count }
      };
    }
    country.totalUsers += 1;

    const key = rec.normalized;
    if (!key) continue;
    let community = country.communities[key];
    if (!community) {
      community = country.communities[key] = {
        name: cleanDisplay(rec.community),
        count: 0,
      };
    }
    community.count += 1;
  }

  // Flatten community maps into sorted arrays and compute summary stats.
  let totalUsers = 0;
  let totalCommunities = 0;
  const out = {};
  for (const id of Object.keys(countries)) {
    const c = countries[id];
    const list = Object.values(c.communities).sort(
      (a, b) => b.count - a.count || a.name.localeCompare(b.name)
    );
    totalUsers += c.totalUsers;
    totalCommunities += list.length;
    out[id] = {
      id: c.id,
      name: c.name,
      totalUsers: c.totalUsers,
      uniqueCommunities: list.length,
      communities: list,
    };
  }

  return {
    countries: out,
    totals: {
      totalUsers,
      totalCommunities,
      activeCountries: Object.keys(out).length,
    },
  };
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function serveStatic(req, res, pathname) {
  // Prevent path traversal; resolve within CLIENT_DIR only.
  const safePath = path
    .normalize(pathname)
    .replace(/^(\.\.[/\\])+/, '');
  let filePath = path.join(CLIENT_DIR, safePath);
  if (pathname === '/' || pathname === '') {
    filePath = path.join(CLIENT_DIR, 'index.html');
  }
  if (!filePath.startsWith(CLIENT_DIR)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

function readBody(req, limit = 1e6) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > limit) {
        reject(new Error('Payload too large'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const { pathname } = url;

  // --- API: read aggregated data ---
  if (req.method === 'GET' && pathname === '/api/data') {
    sendJson(res, 200, aggregate());
    return;
  }

  // --- API: submit a community entry ---
  if (req.method === 'POST' && pathname === '/api/submit') {
    try {
      const raw = await readBody(req);
      const data = JSON.parse(raw || '{}');
      const countryId = String(data.countryId || '').trim();
      const countryName = String(data.countryName || '').trim();
      const community = cleanDisplay(data.community || '');

      if (!countryId || !countryName) {
        sendJson(res, 400, { error: 'A country selection is required.' });
        return;
      }
      if (!community) {
        sendJson(res, 400, { error: 'A community name is required.' });
        return;
      }
      if (community.length > 120) {
        sendJson(res, 400, { error: 'Community name is too long.' });
        return;
      }

      const record = {
        countryId,
        countryName,
        community,
        normalized: normalizeCommunity(community),
        ts: Date.now(),
      };
      submissions.push(record);
      saveSubmissions(submissions);

      sendJson(res, 201, { ok: true, data: aggregate() });
    } catch (err) {
      sendJson(res, 400, { error: 'Invalid request: ' + err.message });
    }
    return;
  }

  // --- API: health ---
  if (req.method === 'GET' && pathname === '/api/health') {
    sendJson(res, 200, { ok: true, submissions: submissions.length });
    return;
  }

  // --- Static client ---
  if (req.method === 'GET') {
    serveStatic(req, res, pathname);
    return;
  }

  res.writeHead(405, { 'Content-Type': 'text/plain' });
  res.end('Method Not Allowed');
});

server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`Global Pulse running at http://localhost:${PORT}`);
});

module.exports = { normalizeCommunity, aggregate };
