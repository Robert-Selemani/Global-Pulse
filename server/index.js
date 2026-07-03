'use strict';

/**
 * Global Pulse - Interactive Community Map
 *
 * A small Node.js HTTP server that powers the community visualization tool
 * described in the Software Functionality Document. It exposes a JSON API, an
 * admin session layer, and serves the static client.
 *
 * Persistence is pluggable: it uses PostgreSQL when DATABASE_URL is set
 * (production, e.g. Render Postgres) and falls back to a JSON file otherwise
 * (local development, no database required).
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

const PORT = process.env.PORT || 3000;
const CLIENT_DIR = path.join(__dirname, '..', 'client');

// File-store location (used only when DATABASE_URL is not set).
const DATA_DIR = process.env.DATA_DIR || __dirname;
const DATA_FILE = path.join(DATA_DIR, 'data.json');

// --- Admin auth configuration ---------------------------------------------
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'change-me';
const SESSION_SECRET =
  process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours
const COOKIE_NAME = 'gp_session';

if (!process.env.ADMIN_PASSWORD) {
  // eslint-disable-next-line no-console
  console.warn(
    '[warn] ADMIN_PASSWORD is not set — using the default "change-me". ' +
      'Set ADMIN_PASSWORD in the environment before deploying.'
  );
}

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
// Storage backends
// ---------------------------------------------------------------------------

/**
 * Both stores expose the same async interface:
 *   init()   -> prepare the backend
 *   add(rec) -> persist one submission
 *   all()    -> [{ countryId, countryName, community, normalized }, ...]
 *   count()  -> number of submissions
 */

function makeFileStore(dataFile) {
  let cache = [];
  function load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
      return Array.isArray(parsed.submissions) ? parsed.submissions : [];
    } catch (err) {
      return [];
    }
  }
  function save() {
    const tmp = dataFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ submissions: cache }, null, 2));
    fs.renameSync(tmp, dataFile); // atomic
  }
  return {
    async init() {
      try {
        fs.mkdirSync(path.dirname(dataFile), { recursive: true });
      } catch (_) {
        /* ignore */
      }
      cache = load();
      // eslint-disable-next-line no-console
      console.log('Storage: JSON file at ' + dataFile);
    },
    async add(rec) {
      cache.push({
        countryId: rec.countryId,
        countryName: rec.countryName,
        community: rec.community,
        normalized: rec.normalized,
        ts: Date.now(),
      });
      save();
    },
    async all() {
      return cache.slice();
    },
    async count() {
      return cache.length;
    },
  };
}

function makePostgresStore(connectionString) {
  // Lazy require so local runs (file store) don't need the pg package.
  const { Pool } = require('pg');

  let ssl = false;
  try {
    const host = new URL(connectionString).hostname;
    // External hosts carry a domain (dots); Render's internal host does not.
    if (host && host !== 'localhost' && host !== '127.0.0.1' && host.includes('.')) {
      ssl = { rejectUnauthorized: false };
    }
  } catch (_) {
    /* keep ssl = false */
  }

  const pool = new Pool({ connectionString, ssl });

  return {
    async init() {
      await pool.query(
        `CREATE TABLE IF NOT EXISTS submissions (
           id           BIGSERIAL PRIMARY KEY,
           country_id   TEXT NOT NULL,
           country_name TEXT NOT NULL,
           community    TEXT NOT NULL,
           normalized   TEXT NOT NULL,
           created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
         )`
      );
      await pool.query(
        `CREATE INDEX IF NOT EXISTS idx_submissions_country
           ON submissions (country_id)`
      );
      // eslint-disable-next-line no-console
      console.log('Storage: PostgreSQL');
    },
    async add(rec) {
      await pool.query(
        `INSERT INTO submissions (country_id, country_name, community, normalized)
         VALUES ($1, $2, $3, $4)`,
        [rec.countryId, rec.countryName, rec.community, rec.normalized]
      );
    },
    async all() {
      const { rows } = await pool.query(
        `SELECT country_id, country_name, community, normalized
           FROM submissions ORDER BY id`
      );
      return rows.map((r) => ({
        countryId: r.country_id,
        countryName: r.country_name,
        community: r.community,
        normalized: r.normalized,
      }));
    },
    async count() {
      const { rows } = await pool.query('SELECT count(*)::int AS n FROM submissions');
      return rows[0].n;
    },
  };
}

const store = process.env.DATABASE_URL
  ? makePostgresStore(process.env.DATABASE_URL)
  : makeFileStore(DATA_FILE);

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

/** Aggregate raw submission rows into per-country community counts. */
function aggregate(rows) {
  const countries = {};

  for (const rec of rows) {
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

async function computeData() {
  return aggregate(await store.all());
}

// ---------------------------------------------------------------------------
// Sessions (signed cookies, no dependencies)
// ---------------------------------------------------------------------------

function verifyToken(token) {
  if (!token) return null;
  const idx = token.lastIndexOf('.');
  if (idx < 0) return null;
  const payload = token.slice(0, idx);
  const sig = token.slice(idx + 1);
  const expected = crypto
    .createHmac('sha256', SESSION_SECRET)
    .update(payload)
    .digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  const parts = payload.split('.');
  if (parts[0] !== 'admin') return null;
  const expiry = Number(parts[1]);
  if (!Number.isFinite(expiry) || Date.now() > expiry) return null;
  return { role: 'admin', expiry };
}

function signToken(payload) {
  const sig = crypto
    .createHmac('sha256', SESSION_SECRET)
    .update(payload)
    .digest('base64url');
  return payload + '.' + sig;
}

function parseCookies(req) {
  const header = req.headers.cookie;
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function isAdmin(req) {
  return !!verifyToken(parseCookies(req)[COOKIE_NAME]);
}

function isSecure(req) {
  return (req.headers['x-forwarded-proto'] || '').split(',')[0] === 'https';
}

function sessionCookie(req, token, maxAgeSec) {
  const attrs = [
    COOKIE_NAME + '=' + (token || ''),
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=' + maxAgeSec,
  ];
  if (isSecure(req)) attrs.push('Secure');
  return attrs.join('; ');
}

/** Constant-time password comparison. */
function passwordMatches(candidate) {
  const a = Buffer.from(String(candidate));
  const b = Buffer.from(ADMIN_PASSWORD);
  if (a.length !== b.length) {
    crypto.timingSafeEqual(b, b);
    return false;
  }
  return crypto.timingSafeEqual(a, b);
}

// --- Simple in-memory login rate limiting ---------------------------------
const loginAttempts = new Map();
const RL_WINDOW_MS = 15 * 60 * 1000;
const RL_MAX = 10;

function rateLimited(ip) {
  const now = Date.now();
  const entry = loginAttempts.get(ip);
  if (!entry || now - entry.first > RL_WINDOW_MS) {
    loginAttempts.set(ip, { count: 1, first: now });
    return false;
  }
  entry.count += 1;
  return entry.count > RL_MAX;
}

function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) return fwd.split(',')[0].trim();
  return req.socket.remoteAddress || 'unknown';
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function setSecurityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-XSS-Protection', '0');
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "img-src 'self' https://*.basemaps.cartocdn.com https://flagcdn.com data:",
      "style-src 'self' 'unsafe-inline'",
      "script-src 'self'",
      "connect-src 'self'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
    ].join('; ')
  );
}

function sendJson(res, status, body, extraHeaders) {
  const payload = JSON.stringify(body);
  const headers = Object.assign(
    { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    extraHeaders || {}
  );
  res.writeHead(status, headers);
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
  const safePath = path.normalize(pathname).replace(/^(\.\.[/\\])+/, '');
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
    const cache = pathname.startsWith('/vendor/')
      ? 'public, max-age=31536000, immutable'
      : 'no-cache';
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': cache,
    });
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
  setSecurityHeaders(res);
  const url = new URL(req.url, `http://${req.headers.host}`);
  const { pathname } = url;

  try {
    // --- API: session status ---
    if (req.method === 'GET' && pathname === '/api/session') {
      sendJson(res, 200, { admin: isAdmin(req) });
      return;
    }

    // --- API: admin login ---
    if (req.method === 'POST' && pathname === '/api/login') {
      if (rateLimited(clientIp(req))) {
        sendJson(res, 429, { error: 'Too many attempts. Try again later.' });
        return;
      }
      const data = JSON.parse((await readBody(req)) || '{}');
      if (!passwordMatches(data.password || '')) {
        sendJson(res, 401, { error: 'Incorrect password.' });
        return;
      }
      const token = signToken('admin.' + (Date.now() + SESSION_TTL_MS));
      sendJson(
        res,
        200,
        { admin: true },
        { 'Set-Cookie': sessionCookie(req, token, SESSION_TTL_MS / 1000) }
      );
      return;
    }

    // --- API: admin logout ---
    if (req.method === 'POST' && pathname === '/api/logout') {
      sendJson(res, 200, { admin: false }, { 'Set-Cookie': sessionCookie(req, '', 0) });
      return;
    }

    // --- API: read aggregated data ---
    if (req.method === 'GET' && pathname === '/api/data') {
      sendJson(res, 200, await computeData());
      return;
    }

    // --- API: submit a community entry ---
    if (req.method === 'POST' && pathname === '/api/submit') {
      const data = JSON.parse((await readBody(req)) || '{}');
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

      await store.add({
        countryId,
        countryName,
        community,
        normalized: normalizeCommunity(community),
      });

      sendJson(res, 201, { ok: true, data: await computeData() });
      return;
    }

    // --- API: health ---
    if (req.method === 'GET' && pathname === '/api/health') {
      sendJson(res, 200, { ok: true, submissions: await store.count() });
      return;
    }

    // --- Unknown API route ---
    if (pathname.startsWith('/api/')) {
      sendJson(res, 404, { error: 'Not found' });
      return;
    }

    // --- Static client ---
    if (req.method === 'GET') {
      serveStatic(req, res, pathname);
      return;
    }

    res.writeHead(405, { 'Content-Type': 'text/plain' });
    res.end('Method Not Allowed');
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('Request error:', err.message);
    if (!res.headersSent) sendJson(res, 500, { error: 'Server error' });
  }
});

store
  .init()
  .then(() => {
    server.listen(PORT, () => {
      // eslint-disable-next-line no-console
      console.log(`Global Pulse running at http://localhost:${PORT}`);
    });
  })
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error('Failed to initialize storage:', err.message);
    process.exit(1);
  });

module.exports = { normalizeCommunity, aggregate };
