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

// --- Auth configuration ----------------------------------------------------
// Accounts are stored in the database. The first account to sign up becomes
// the super admin; everyone else is an end user. Sessions are signed cookies
// carrying the user id.
const SESSION_SECRET =
  process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours
const COOKIE_NAME = 'gp_session';
const ROLE_SUPER = 'super_admin';
const ROLE_USER = 'end_user';

// --- Password hashing (scrypt, no external dependency) ---------------------
function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, 64);
  return 'scrypt$' + salt.toString('hex') + '$' + hash.toString('hex');
}

function verifyPassword(password, stored) {
  try {
    const [scheme, saltHex, hashHex] = String(stored).split('$');
    if (scheme !== 'scrypt') return false;
    const hash = Buffer.from(hashHex, 'hex');
    const test = crypto.scryptSync(String(password), Buffer.from(saltHex, 'hex'), hash.length);
    return crypto.timingSafeEqual(hash, test);
  } catch (_) {
    return false;
  }
}

function validEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || ''));
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

/** Validate a submission/edit payload; returns an error string or null. */
function validateEntry(data) {
  const countryId = String(data.countryId || '').trim();
  const countryName = String(data.countryName || '').trim();
  const community = cleanDisplay(data.community || '');
  if (!countryId || !countryName) return 'A country selection is required.';
  if (!community) return 'A community name is required.';
  if (community.length > 120) return 'Community name is too long.';
  return null;
}

// ---------------------------------------------------------------------------
// Storage backends
// ---------------------------------------------------------------------------

/**
 * Both stores expose the same async interface:
 *   init()                     -> prepare the backend
 *   add(rec)                   -> persist a submission, returns its id
 *   all()                      -> all submissions (with id, participantId)
 *   count()                    -> number of submissions
 *   getById(id)                -> one submission or null
 *   update(id, fields)         -> update a submission
 *   remove(id)                 -> delete a submission
 *   listByParticipant(pid)     -> a participant's own submissions
 *   getSetting(key)/setSetting -> small key/value store (participation code)
 */

function makeFileStore(dataFile) {
  let cache = [];
  let nextId = 1;
  let settings = {};
  let users = [];
  let nextUserId = 1;

  function load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
      cache = Array.isArray(parsed.submissions) ? parsed.submissions : [];
      settings = parsed.settings && typeof parsed.settings === 'object' ? parsed.settings : {};
      users = Array.isArray(parsed.users) ? parsed.users : [];
      nextId = cache.reduce((m, r) => Math.max(m, r.id || 0), 0) + 1;
      nextUserId = users.reduce((m, u) => Math.max(m, u.id || 0), 0) + 1;
    } catch (err) {
      cache = [];
      settings = {};
      users = [];
      nextId = 1;
      nextUserId = 1;
    }
  }
  function save() {
    const tmp = dataFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ submissions: cache, settings, users }, null, 2));
    fs.renameSync(tmp, dataFile); // atomic
  }
  return {
    async init() {
      try {
        fs.mkdirSync(path.dirname(dataFile), { recursive: true });
      } catch (_) {
        /* ignore */
      }
      load();
      // eslint-disable-next-line no-console
      console.log('Storage: JSON file at ' + dataFile);
    },
    async add(rec) {
      const id = nextId++;
      cache.push({
        id,
        participantId: rec.participantId || null,
        countryId: rec.countryId,
        countryName: rec.countryName,
        community: rec.community,
        normalized: rec.normalized,
        ts: Date.now(),
      });
      save();
      return id;
    },
    async all() {
      return cache.slice();
    },
    async count() {
      return cache.length;
    },
    async getById(id) {
      return cache.find((r) => r.id === id) || null;
    },
    async update(id, fields) {
      const rec = cache.find((r) => r.id === id);
      if (!rec) return false;
      Object.assign(rec, fields);
      save();
      return true;
    },
    async remove(id) {
      const before = cache.length;
      cache = cache.filter((r) => r.id !== id);
      if (cache.length === before) return false;
      save();
      return true;
    },
    async listByParticipant(pid) {
      return cache.filter((r) => r.participantId === pid);
    },
    async getSetting(key) {
      return Object.prototype.hasOwnProperty.call(settings, key) ? settings[key] : null;
    },
    async setSetting(key, value) {
      if (value === null) delete settings[key];
      else settings[key] = value;
      save();
    },
    async countUsers() {
      return users.length;
    },
    async getUserByEmail(email) {
      const e = String(email).toLowerCase();
      return users.find((u) => u.email === e) || null;
    },
    async getUserById(id) {
      return users.find((u) => u.id === Number(id)) || null;
    },
    async createUser({ email, passwordHash, role }) {
      const user = {
        id: nextUserId++,
        email: String(email).toLowerCase(),
        passwordHash,
        role,
        createdAt: Date.now(),
      };
      users.push(user);
      save();
      return { id: user.id, email: user.email, role: user.role };
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

  function mapRow(r) {
    return {
      id: Number(r.id),
      participantId: r.participant_id,
      countryId: r.country_id,
      countryName: r.country_name,
      community: r.community,
      normalized: r.normalized,
    };
  }

  return {
    async init() {
      await pool.query(
        `CREATE TABLE IF NOT EXISTS submissions (
           id             BIGSERIAL PRIMARY KEY,
           participant_id TEXT,
           country_id     TEXT NOT NULL,
           country_name   TEXT NOT NULL,
           community      TEXT NOT NULL,
           normalized     TEXT NOT NULL,
           created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
         )`
      );
      // Add the column if upgrading from an older schema.
      await pool.query('ALTER TABLE submissions ADD COLUMN IF NOT EXISTS participant_id TEXT');
      await pool.query(
        `CREATE INDEX IF NOT EXISTS idx_submissions_country ON submissions (country_id)`
      );
      await pool.query(
        `CREATE INDEX IF NOT EXISTS idx_submissions_participant ON submissions (participant_id)`
      );
      await pool.query(
        `CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)`
      );
      await pool.query(
        `CREATE TABLE IF NOT EXISTS users (
           id            BIGSERIAL PRIMARY KEY,
           email         TEXT UNIQUE NOT NULL,
           password_hash TEXT NOT NULL,
           role          TEXT NOT NULL,
           created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
         )`
      );
      // eslint-disable-next-line no-console
      console.log('Storage: PostgreSQL');
    },
    async add(rec) {
      const { rows } = await pool.query(
        `INSERT INTO submissions (participant_id, country_id, country_name, community, normalized)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [rec.participantId || null, rec.countryId, rec.countryName, rec.community, rec.normalized]
      );
      return Number(rows[0].id);
    },
    async all() {
      const { rows } = await pool.query(
        `SELECT id, participant_id, country_id, country_name, community, normalized
           FROM submissions ORDER BY id`
      );
      return rows.map(mapRow);
    },
    async count() {
      const { rows } = await pool.query('SELECT count(*)::int AS n FROM submissions');
      return rows[0].n;
    },
    async getById(id) {
      const { rows } = await pool.query(
        `SELECT id, participant_id, country_id, country_name, community, normalized
           FROM submissions WHERE id = $1`,
        [id]
      );
      return rows[0] ? mapRow(rows[0]) : null;
    },
    async update(id, f) {
      const { rowCount } = await pool.query(
        `UPDATE submissions
            SET country_id = $2, country_name = $3, community = $4, normalized = $5
          WHERE id = $1`,
        [id, f.countryId, f.countryName, f.community, f.normalized]
      );
      return rowCount > 0;
    },
    async remove(id) {
      const { rowCount } = await pool.query('DELETE FROM submissions WHERE id = $1', [id]);
      return rowCount > 0;
    },
    async listByParticipant(pid) {
      const { rows } = await pool.query(
        `SELECT id, participant_id, country_id, country_name, community, normalized
           FROM submissions WHERE participant_id = $1 ORDER BY id`,
        [pid]
      );
      return rows.map(mapRow);
    },
    async getSetting(key) {
      const { rows } = await pool.query('SELECT value FROM settings WHERE key = $1', [key]);
      return rows[0] ? rows[0].value : null;
    },
    async setSetting(key, value) {
      if (value === null) {
        await pool.query('DELETE FROM settings WHERE key = $1', [key]);
      } else {
        await pool.query(
          `INSERT INTO settings (key, value) VALUES ($1, $2)
             ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
          [key, value]
        );
      }
    },
    async countUsers() {
      const { rows } = await pool.query('SELECT count(*)::int AS n FROM users');
      return rows[0].n;
    },
    async getUserByEmail(email) {
      const { rows } = await pool.query(
        'SELECT id, email, password_hash, role FROM users WHERE email = $1',
        [String(email).toLowerCase()]
      );
      if (!rows[0]) return null;
      return {
        id: Number(rows[0].id),
        email: rows[0].email,
        passwordHash: rows[0].password_hash,
        role: rows[0].role,
      };
    },
    async getUserById(id) {
      const { rows } = await pool.query(
        'SELECT id, email, role FROM users WHERE id = $1',
        [Number(id)]
      );
      if (!rows[0]) return null;
      return { id: Number(rows[0].id), email: rows[0].email, role: rows[0].role };
    },
    async createUser({ email, passwordHash, role }) {
      const { rows } = await pool.query(
        `INSERT INTO users (email, password_hash, role) VALUES ($1, $2, $3)
           RETURNING id, email, role`,
        [String(email).toLowerCase(), passwordHash, role]
      );
      return { id: Number(rows[0].id), email: rows[0].email, role: rows[0].role };
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
// Participation code
// ---------------------------------------------------------------------------

const CODE_KEY = 'participation_code';

/** Generate a short, human-friendly code (no ambiguous characters). */
function generateCode() {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let out = '';
  const bytes = crypto.randomBytes(6);
  for (let i = 0; i < 6; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

async function getActiveCode() {
  return store.getSetting(CODE_KEY);
}

/**
 * A code is only required once an admin has set one. When required, the
 * supplied code must match (case-insensitively).
 */
async function codeAccepted(supplied) {
  const active = await getActiveCode();
  if (!active) return true; // participation open until a code is set
  return String(supplied || '').trim().toUpperCase() === active;
}

// ---------------------------------------------------------------------------
// Sessions (signed cookies, no dependencies)
// ---------------------------------------------------------------------------

/** Token payload is "<userId>.<expiryMs>", HMAC-signed. */
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
  const userId = Number(parts[0]);
  const expiry = Number(parts[1]);
  if (!Number.isFinite(userId) || !Number.isFinite(expiry) || Date.now() > expiry) {
    return null;
  }
  return { userId, expiry };
}

function signToken(payload) {
  const sig = crypto
    .createHmac('sha256', SESSION_SECRET)
    .update(payload)
    .digest('base64url');
  return payload + '.' + sig;
}

function makeSessionToken(userId) {
  return signToken(userId + '.' + (Date.now() + SESSION_TTL_MS));
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

/** Resolve the authenticated user for a request, or null. */
async function currentUser(req) {
  const tok = verifyToken(parseCookies(req)[COOKIE_NAME]);
  if (!tok) return null;
  return store.getUserById(tok.userId);
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
      "img-src 'self' https://flagcdn.com data:",
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
    const user = await currentUser(req);

    // --- API: session status ---
    if (req.method === 'GET' && pathname === '/api/session') {
      sendJson(res, 200, {
        authenticated: !!user,
        email: user ? user.email : null,
        role: user ? user.role : null,
        isSuperAdmin: !!user && user.role === ROLE_SUPER,
        hasUsers: (await store.countUsers()) > 0,
      });
      return;
    }

    // --- API: sign up (first user becomes super admin) ---
    if (req.method === 'POST' && pathname === '/api/signup') {
      if (rateLimited(clientIp(req))) {
        sendJson(res, 429, { error: 'Too many attempts. Try again later.' });
        return;
      }
      const data = JSON.parse((await readBody(req)) || '{}');
      const email = String(data.email || '').trim().toLowerCase();
      const password = String(data.password || '');
      if (!validEmail(email)) {
        sendJson(res, 400, { error: 'Please enter a valid email address.' });
        return;
      }
      if (password.length < 6) {
        sendJson(res, 400, { error: 'Password must be at least 6 characters.' });
        return;
      }
      if (await store.getUserByEmail(email)) {
        sendJson(res, 409, { error: 'An account with that email already exists.' });
        return;
      }
      const role = (await store.countUsers()) === 0 ? ROLE_SUPER : ROLE_USER;
      const created = await store.createUser({
        email,
        passwordHash: hashPassword(password),
        role,
      });
      const token = makeSessionToken(created.id);
      sendJson(
        res,
        201,
        { email: created.email, role: created.role, isSuperAdmin: role === ROLE_SUPER },
        { 'Set-Cookie': sessionCookie(req, token, SESSION_TTL_MS / 1000) }
      );
      return;
    }

    // --- API: log in ---
    if (req.method === 'POST' && pathname === '/api/login') {
      if (rateLimited(clientIp(req))) {
        sendJson(res, 429, { error: 'Too many attempts. Try again later.' });
        return;
      }
      const data = JSON.parse((await readBody(req)) || '{}');
      const email = String(data.email || '').trim().toLowerCase();
      const account = await store.getUserByEmail(email);
      if (!account || !verifyPassword(data.password || '', account.passwordHash)) {
        sendJson(res, 401, { error: 'Incorrect email or password.' });
        return;
      }
      const token = makeSessionToken(account.id);
      sendJson(
        res,
        200,
        { email: account.email, role: account.role, isSuperAdmin: account.role === ROLE_SUPER },
        { 'Set-Cookie': sessionCookie(req, token, SESSION_TTL_MS / 1000) }
      );
      return;
    }

    // --- API: log out ---
    if (req.method === 'POST' && pathname === '/api/logout') {
      sendJson(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(req, '', 0) });
      return;
    }

    // --- API: read aggregated data ---
    if (req.method === 'GET' && pathname === '/api/data') {
      sendJson(res, 200, await computeData());
      return;
    }

    // --- API: public config (whether a participation code is required) ---
    if (req.method === 'GET' && pathname === '/api/config') {
      sendJson(res, 200, { participationRequired: !!(await getActiveCode()) });
      return;
    }

    // --- API: the logged-in user's own submissions ---
    if (req.method === 'GET' && pathname === '/api/mine') {
      if (!user) {
        sendJson(res, 200, { submissions: [] });
        return;
      }
      const mine = await store.listByParticipant(String(user.id));
      sendJson(res, 200, {
        submissions: mine.map((r) => ({
          id: r.id,
          countryId: r.countryId,
          countryName: r.countryName,
          community: r.community,
        })),
      });
      return;
    }

    // --- API: submit a community entry (must be logged in) ---
    if (req.method === 'POST' && pathname === '/api/submit') {
      if (!user) {
        sendJson(res, 401, { error: 'Please sign in to participate.' });
        return;
      }
      const data = JSON.parse((await readBody(req)) || '{}');
      const err = validateEntry(data);
      if (err) {
        sendJson(res, 400, { error: err });
        return;
      }
      if (!(await codeAccepted(data.code))) {
        sendJson(res, 403, { error: 'Invalid participation code.', code: 'BAD_CODE' });
        return;
      }
      const community = cleanDisplay(data.community);
      const id = await store.add({
        participantId: String(user.id),
        countryId: String(data.countryId).trim(),
        countryName: String(data.countryName).trim(),
        community,
        normalized: normalizeCommunity(community),
      });
      sendJson(res, 201, { ok: true, id, data: await computeData() });
      return;
    }

    // --- API: edit or withdraw one's own submission ---
    const subMatch = pathname.match(/^\/api\/submission\/(\d+)$/);
    if (subMatch) {
      if (!user) {
        sendJson(res, 401, { error: 'Please sign in.' });
        return;
      }
      const id = Number(subMatch[1]);
      const record = await store.getById(id);
      const owns = record && record.participantId === String(user.id);

      if (req.method === 'DELETE') {
        if (!owns) {
          sendJson(res, 403, { error: 'You can only withdraw your own submission.' });
          return;
        }
        await store.remove(id);
        sendJson(res, 200, { ok: true, data: await computeData() });
        return;
      }

      if (req.method === 'PUT') {
        if (!owns) {
          sendJson(res, 403, { error: 'You can only edit your own submission.' });
          return;
        }
        const data = JSON.parse((await readBody(req)) || '{}');
        const verr = validateEntry(data);
        if (verr) {
          sendJson(res, 400, { error: verr });
          return;
        }
        if (!(await codeAccepted(data.code))) {
          sendJson(res, 403, { error: 'Invalid participation code.', code: 'BAD_CODE' });
          return;
        }
        const community = cleanDisplay(data.community);
        await store.update(id, {
          countryId: String(data.countryId).trim(),
          countryName: String(data.countryName).trim(),
          community,
          normalized: normalizeCommunity(community),
        });
        sendJson(res, 200, { ok: true, data: await computeData() });
        return;
      }

      sendJson(res, 405, { error: 'Method not allowed' });
      return;
    }

    // --- API: participation code management (super admin only) ---
    if (pathname === '/api/admin/code') {
      if (!user || user.role !== ROLE_SUPER) {
        sendJson(res, 403, { error: 'Super admin access required.' });
        return;
      }
      if (req.method === 'GET') {
        sendJson(res, 200, { code: await getActiveCode() });
        return;
      }
      if (req.method === 'POST') {
        const code = generateCode();
        await store.setSetting(CODE_KEY, code);
        sendJson(res, 200, { code });
        return;
      }
      if (req.method === 'DELETE') {
        await store.setSetting(CODE_KEY, null);
        sendJson(res, 200, { code: null });
        return;
      }
      sendJson(res, 405, { error: 'Method not allowed' });
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

    // --- Page routes (clean URLs -> HTML files) ---
    const PAGES = {
      '/': 'present.html',
      '/present': 'present.html',
      '/vote': 'vote.html',
      '/login': 'login.html',
      '/signup': 'signup.html',
    };
    if (req.method === 'GET' && Object.prototype.hasOwnProperty.call(PAGES, pathname)) {
      serveStatic(req, res, '/' + PAGES[pathname]);
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
