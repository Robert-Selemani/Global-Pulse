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
// Subscription plans (seed data)
// ---------------------------------------------------------------------------
// Plans are schema-only for now: no billing provider and no limits enforced.
// The values below are seeded into the `plans` table so the subscriptions
// model has something to reference and the UI can display tiers.
const PLAN_SEED = [
  { id: 'free', name: 'Free', price_cents: 0, max_polls: 1, max_participants: 100, features: { export: false } },
  { id: 'pro', name: 'Pro', price_cents: 2900, max_polls: 25, max_participants: 2000, features: { export: true } },
  { id: 'business', name: 'Business', price_cents: 9900, max_polls: null, max_participants: null, features: { export: true } },
];
const DEFAULT_PLAN_ID = 'free';

/** Build a URL-safe slug from a poll title (uniqueness handled by the store). */
function slugify(title) {
  const base = String(title || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return base || 'poll';
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
  let polls = [];
  let nextPollId = 1;
  let subscriptions = [];
  let nextSubId = 1;

  function load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
      cache = Array.isArray(parsed.submissions) ? parsed.submissions : [];
      settings = parsed.settings && typeof parsed.settings === 'object' ? parsed.settings : {};
      users = Array.isArray(parsed.users) ? parsed.users : [];
      polls = Array.isArray(parsed.polls) ? parsed.polls : [];
      subscriptions = Array.isArray(parsed.subscriptions) ? parsed.subscriptions : [];
      nextId = cache.reduce((m, r) => Math.max(m, r.id || 0), 0) + 1;
      nextUserId = users.reduce((m, u) => Math.max(m, u.id || 0), 0) + 1;
      nextPollId = polls.reduce((m, p) => Math.max(m, p.id || 0), 0) + 1;
      nextSubId = subscriptions.reduce((m, s) => Math.max(m, s.id || 0), 0) + 1;
    } catch (err) {
      cache = [];
      settings = {};
      users = [];
      polls = [];
      subscriptions = [];
      nextId = 1;
      nextUserId = 1;
      nextPollId = 1;
      nextSubId = 1;
    }
  }
  function save() {
    const tmp = dataFile + '.tmp';
    fs.writeFileSync(
      tmp,
      JSON.stringify({ submissions: cache, settings, users, polls, subscriptions }, null, 2)
    );
    fs.renameSync(tmp, dataFile); // atomic
  }

  function uniqueSlug(base) {
    const taken = new Set(polls.map((p) => p.slug));
    if (!taken.has(base)) return base;
    let n = 2;
    while (taken.has(base + '-' + n)) n++;
    return base + '-' + n;
  }

  function mapPoll(p) {
    if (!p) return null;
    const subs = cache.filter((r) => r.pollId === p.id);
    const communities = new Set(subs.map((r) => r.normalized).filter(Boolean));
    return {
      id: p.id,
      ownerId: p.ownerId,
      title: p.title,
      slug: p.slug,
      description: p.description || '',
      status: p.status,
      participationCode: p.participationCode || null,
      settings: p.settings || {},
      createdAt: p.createdAt,
      archivedAt: p.archivedAt || null,
      submissionCount: subs.length,
      communityCount: communities.size,
    };
  }

  function newSubscription(userId) {
    return {
      id: nextSubId++,
      userId,
      planId: DEFAULT_PLAN_ID,
      status: 'active',
      provider: 'none',
      providerCustomerId: null,
      providerSubscriptionId: null,
      currentPeriodEnd: null,
      createdAt: Date.now(),
    };
  }

  // One-time, idempotent migration of legacy single-poll data.
  function migrate() {
    let changed = false;
    const hasOrphans = cache.some((r) => !r.pollId);
    if (hasOrphans) {
      let def = polls.find((p) => p.slug === 'global-pulse');
      if (!def) {
        const owner = users.find((u) => u.role === ROLE_SUPER) || users[0];
        def = {
          id: nextPollId++,
          ownerId: owner ? owner.id : null,
          title: 'Global Pulse',
          slug: 'global-pulse',
          description: 'Imported from the original single-poll map.',
          status: 'active',
          participationCode: settings.participation_code || null,
          settings: {},
          createdAt: Date.now(),
          archivedAt: null,
        };
        polls.push(def);
      }
      for (const r of cache) {
        if (!r.pollId) r.pollId = def.id;
      }
      changed = true;
    }
    for (const u of users) {
      if (!subscriptions.find((s) => s.userId === u.id)) {
        subscriptions.push(newSubscription(u.id));
        changed = true;
      }
    }
    if (changed) save();
  }

  return {
    async init() {
      try {
        fs.mkdirSync(path.dirname(dataFile), { recursive: true });
      } catch (_) {
        /* ignore */
      }
      load();
      migrate();
      // eslint-disable-next-line no-console
      console.log('Storage: JSON file at ' + dataFile);
    },

    // --- Submissions (poll-scoped) ---
    async add(rec) {
      const id = nextId++;
      cache.push({
        id,
        pollId: rec.pollId,
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
    async all(pollId) {
      const rows = pollId == null ? cache : cache.filter((r) => r.pollId === pollId);
      return rows.slice();
    },
    async count(pollId) {
      if (pollId == null) return cache.length;
      return cache.filter((r) => r.pollId === pollId).length;
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
    async listByParticipant(pollId, pid) {
      return cache.filter((r) => r.pollId === pollId && r.participantId === pid);
    },

    // --- Polls ---
    async createPoll({ ownerId, title, description }) {
      const poll = {
        id: nextPollId++,
        ownerId,
        title: cleanDisplay(title),
        slug: uniqueSlug(slugify(title)),
        description: cleanDisplay(description || ''),
        status: 'active',
        participationCode: null,
        settings: {},
        createdAt: Date.now(),
        archivedAt: null,
      };
      polls.push(poll);
      save();
      return mapPoll(poll);
    },
    async getPollById(id) {
      return mapPoll(polls.find((p) => p.id === Number(id)));
    },
    async getPollBySlug(slug) {
      return mapPoll(polls.find((p) => p.slug === slug));
    },
    async getPollByCode(code) {
      const c = String(code || '').trim().toUpperCase();
      if (!c) return null;
      return mapPoll(
        polls.find((p) => p.status !== 'archived' && (p.participationCode || '') === c)
      );
    },
    async listPollsByOwner(ownerId) {
      return polls
        .filter((p) => p.ownerId === Number(ownerId))
        .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
        .map(mapPoll);
    },
    async updatePoll(id, fields) {
      const poll = polls.find((p) => p.id === Number(id));
      if (!poll) return null;
      if (fields.title != null) poll.title = cleanDisplay(fields.title);
      if (fields.description != null) poll.description = cleanDisplay(fields.description);
      if (fields.settings != null) poll.settings = fields.settings;
      if (fields.status != null) poll.status = fields.status;
      if (Object.prototype.hasOwnProperty.call(fields, 'participationCode')) {
        poll.participationCode = fields.participationCode;
      }
      save();
      return mapPoll(poll);
    },
    async archivePoll(id) {
      const poll = polls.find((p) => p.id === Number(id));
      if (!poll) return null;
      poll.status = 'archived';
      poll.archivedAt = Date.now();
      save();
      return mapPoll(poll);
    },
    async deletePoll(id) {
      const pid = Number(id);
      const before = polls.length;
      polls = polls.filter((p) => p.id !== pid);
      if (polls.length === before) return false;
      cache = cache.filter((r) => r.pollId !== pid);
      save();
      return true;
    },

    // --- Settings (global key/value) ---
    async getSetting(key) {
      return Object.prototype.hasOwnProperty.call(settings, key) ? settings[key] : null;
    },
    async setSetting(key, value) {
      if (value === null) delete settings[key];
      else settings[key] = value;
      save();
    },

    // --- Users ---
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
      subscriptions.push(newSubscription(user.id));
      save();
      return { id: user.id, email: user.email, role: user.role };
    },

    // --- Plans & subscriptions (schema only) ---
    async listPlans() {
      return PLAN_SEED.map((p) => ({ ...p }));
    },
    async getSubscriptionByUser(userId) {
      const s = subscriptions.find((x) => x.userId === Number(userId));
      return s ? { ...s } : null;
    },
    async setSubscriptionPlan(userId, planId) {
      let s = subscriptions.find((x) => x.userId === Number(userId));
      if (!s) {
        s = newSubscription(Number(userId));
        subscriptions.push(s);
      }
      s.planId = planId;
      s.status = 'active';
      save();
      return { ...s };
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
      pollId: r.poll_id != null ? Number(r.poll_id) : null,
      participantId: r.participant_id,
      countryId: r.country_id,
      countryName: r.country_name,
      community: r.community,
      normalized: r.normalized,
    };
  }

  const asMs = (v) => (v ? new Date(v).getTime() : null);

  function mapPoll(r) {
    if (!r) return null;
    return {
      id: Number(r.id),
      ownerId: r.owner_id != null ? Number(r.owner_id) : null,
      title: r.title,
      slug: r.slug,
      description: r.description || '',
      status: r.status,
      participationCode: r.participation_code || null,
      settings: r.settings || {},
      createdAt: asMs(r.created_at),
      archivedAt: asMs(r.archived_at),
      submissionCount: r.submission_count != null ? Number(r.submission_count) : 0,
      communityCount: r.community_count != null ? Number(r.community_count) : 0,
    };
  }

  // Shared SELECT that carries per-poll counts.
  const POLL_SELECT = `
    SELECT p.*,
      (SELECT count(*)::int FROM submissions s WHERE s.poll_id = p.id) AS submission_count,
      (SELECT count(DISTINCT s.normalized)::int FROM submissions s WHERE s.poll_id = p.id)
        AS community_count
      FROM polls p`;

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
      // Add columns if upgrading from an older schema.
      await pool.query('ALTER TABLE submissions ADD COLUMN IF NOT EXISTS participant_id TEXT');
      await pool.query('ALTER TABLE submissions ADD COLUMN IF NOT EXISTS poll_id BIGINT');
      await pool.query(
        `CREATE INDEX IF NOT EXISTS idx_submissions_country ON submissions (country_id)`
      );
      await pool.query(
        `CREATE INDEX IF NOT EXISTS idx_submissions_participant ON submissions (participant_id)`
      );
      await pool.query(
        `CREATE INDEX IF NOT EXISTS idx_submissions_poll ON submissions (poll_id)`
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
      await pool.query(
        `CREATE TABLE IF NOT EXISTS polls (
           id                 BIGSERIAL PRIMARY KEY,
           owner_id           BIGINT REFERENCES users(id),
           title              TEXT NOT NULL,
           slug               TEXT UNIQUE NOT NULL,
           description        TEXT,
           status             TEXT NOT NULL DEFAULT 'active',
           participation_code TEXT,
           settings           JSONB NOT NULL DEFAULT '{}',
           created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
           archived_at        TIMESTAMPTZ
         )`
      );
      await pool.query(`CREATE INDEX IF NOT EXISTS idx_polls_owner ON polls (owner_id)`);
      await pool.query(`CREATE INDEX IF NOT EXISTS idx_polls_slug ON polls (slug)`);
      await pool.query(
        `CREATE TABLE IF NOT EXISTS plans (
           id               TEXT PRIMARY KEY,
           name             TEXT NOT NULL,
           price_cents      INTEGER NOT NULL DEFAULT 0,
           max_polls        INTEGER,
           max_participants INTEGER,
           features         JSONB NOT NULL DEFAULT '{}'
         )`
      );
      await pool.query(
        `CREATE TABLE IF NOT EXISTS subscriptions (
           id                       BIGSERIAL PRIMARY KEY,
           user_id                  BIGINT NOT NULL REFERENCES users(id),
           plan_id                  TEXT NOT NULL REFERENCES plans(id) DEFAULT 'free',
           status                   TEXT NOT NULL DEFAULT 'active',
           provider                 TEXT NOT NULL DEFAULT 'none',
           provider_customer_id     TEXT,
           provider_subscription_id TEXT,
           current_period_end       TIMESTAMPTZ,
           created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
           UNIQUE (user_id)
         )`
      );

      // Seed / refresh plans.
      for (const p of PLAN_SEED) {
        await pool.query(
          `INSERT INTO plans (id, name, price_cents, max_polls, max_participants, features)
             VALUES ($1, $2, $3, $4, $5, $6)
             ON CONFLICT (id) DO UPDATE SET
               name = EXCLUDED.name, price_cents = EXCLUDED.price_cents,
               max_polls = EXCLUDED.max_polls, max_participants = EXCLUDED.max_participants,
               features = EXCLUDED.features`,
          [p.id, p.name, p.price_cents, p.max_polls, p.max_participants, JSON.stringify(p.features)]
        );
      }

      await this._migrate();
      // eslint-disable-next-line no-console
      console.log('Storage: PostgreSQL');
    },

    // Idempotent migration of legacy single-poll data.
    async _migrate() {
      const { rows: orph } = await pool.query(
        'SELECT count(*)::int AS n FROM submissions WHERE poll_id IS NULL'
      );
      if (orph[0].n > 0) {
        let { rows: existing } = await pool.query(
          `SELECT id FROM polls WHERE slug = 'global-pulse'`
        );
        let defId = existing[0] ? Number(existing[0].id) : null;
        if (defId == null) {
          const { rows: owner } = await pool.query(
            `SELECT id FROM users ORDER BY (role = 'super_admin') DESC, id ASC LIMIT 1`
          );
          if (owner[0]) {
            const { rows: codeRow } = await pool.query(
              `SELECT value FROM settings WHERE key = 'participation_code'`
            );
            const { rows: ins } = await pool.query(
              `INSERT INTO polls (owner_id, title, slug, description, status, participation_code)
                 VALUES ($1, 'Global Pulse', 'global-pulse',
                         'Imported from the original single-poll map.', 'active', $2)
                 RETURNING id`,
              [Number(owner[0].id), codeRow[0] ? codeRow[0].value : null]
            );
            defId = Number(ins[0].id);
          }
        }
        if (defId != null) {
          await pool.query('UPDATE submissions SET poll_id = $1 WHERE poll_id IS NULL', [defId]);
        }
      }
      // Backfill a free subscription for any user missing one.
      await pool.query(
        `INSERT INTO subscriptions (user_id, plan_id)
           SELECT u.id, $1 FROM users u
           WHERE NOT EXISTS (SELECT 1 FROM subscriptions s WHERE s.user_id = u.id)`,
        [DEFAULT_PLAN_ID]
      );
    },

    // --- Submissions (poll-scoped) ---
    async add(rec) {
      const { rows } = await pool.query(
        `INSERT INTO submissions (poll_id, participant_id, country_id, country_name, community, normalized)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [
          rec.pollId,
          rec.participantId || null,
          rec.countryId,
          rec.countryName,
          rec.community,
          rec.normalized,
        ]
      );
      return Number(rows[0].id);
    },
    async all(pollId) {
      if (pollId == null) {
        const { rows } = await pool.query(
          `SELECT id, poll_id, participant_id, country_id, country_name, community, normalized
             FROM submissions ORDER BY id`
        );
        return rows.map(mapRow);
      }
      const { rows } = await pool.query(
        `SELECT id, poll_id, participant_id, country_id, country_name, community, normalized
           FROM submissions WHERE poll_id = $1 ORDER BY id`,
        [pollId]
      );
      return rows.map(mapRow);
    },
    async count(pollId) {
      if (pollId == null) {
        const { rows } = await pool.query('SELECT count(*)::int AS n FROM submissions');
        return rows[0].n;
      }
      const { rows } = await pool.query(
        'SELECT count(*)::int AS n FROM submissions WHERE poll_id = $1',
        [pollId]
      );
      return rows[0].n;
    },
    async getById(id) {
      const { rows } = await pool.query(
        `SELECT id, poll_id, participant_id, country_id, country_name, community, normalized
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
    async listByParticipant(pollId, pid) {
      const { rows } = await pool.query(
        `SELECT id, poll_id, participant_id, country_id, country_name, community, normalized
           FROM submissions WHERE poll_id = $1 AND participant_id = $2 ORDER BY id`,
        [pollId, pid]
      );
      return rows.map(mapRow);
    },

    // --- Polls ---
    async createPoll({ ownerId, title, description }) {
      const base = slugify(title);
      let slug = base;
      for (let attempt = 0; attempt < 50; attempt++) {
        try {
          const { rows } = await pool.query(
            `INSERT INTO polls (owner_id, title, slug, description, status)
               VALUES ($1, $2, $3, $4, 'active') RETURNING id`,
            [ownerId, cleanDisplay(title), slug, cleanDisplay(description || '')]
          );
          return this.getPollById(Number(rows[0].id));
        } catch (e) {
          if (e.code === '23505') {
            slug = base + '-' + (attempt + 2);
            continue;
          }
          throw e;
        }
      }
      throw new Error('Could not allocate a unique slug');
    },
    async getPollById(id) {
      const { rows } = await pool.query(`${POLL_SELECT} WHERE p.id = $1`, [Number(id)]);
      return rows[0] ? mapPoll(rows[0]) : null;
    },
    async getPollBySlug(slug) {
      const { rows } = await pool.query(`${POLL_SELECT} WHERE p.slug = $1`, [slug]);
      return rows[0] ? mapPoll(rows[0]) : null;
    },
    async getPollByCode(code) {
      const c = String(code || '').trim().toUpperCase();
      if (!c) return null;
      const { rows } = await pool.query(
        `${POLL_SELECT} WHERE p.status <> 'archived' AND upper(p.participation_code) = $1 LIMIT 1`,
        [c]
      );
      return rows[0] ? mapPoll(rows[0]) : null;
    },
    async listPollsByOwner(ownerId) {
      const { rows } = await pool.query(
        `${POLL_SELECT} WHERE p.owner_id = $1 ORDER BY p.created_at DESC`,
        [Number(ownerId)]
      );
      return rows.map(mapPoll);
    },
    async updatePoll(id, fields) {
      const sets = [];
      const vals = [Number(id)];
      const push = (col, val) => {
        vals.push(val);
        sets.push(`${col} = $${vals.length}`);
      };
      if (fields.title != null) push('title', cleanDisplay(fields.title));
      if (fields.description != null) push('description', cleanDisplay(fields.description));
      if (fields.settings != null) push('settings', JSON.stringify(fields.settings));
      if (fields.status != null) push('status', fields.status);
      if (Object.prototype.hasOwnProperty.call(fields, 'participationCode')) {
        push('participation_code', fields.participationCode);
      }
      if (!sets.length) return this.getPollById(id);
      await pool.query(`UPDATE polls SET ${sets.join(', ')} WHERE id = $1`, vals);
      return this.getPollById(id);
    },
    async archivePoll(id) {
      await pool.query(
        `UPDATE polls SET status = 'archived', archived_at = now() WHERE id = $1`,
        [Number(id)]
      );
      return this.getPollById(id);
    },
    async deletePoll(id) {
      const pid = Number(id);
      await pool.query('DELETE FROM submissions WHERE poll_id = $1', [pid]);
      const { rowCount } = await pool.query('DELETE FROM polls WHERE id = $1', [pid]);
      return rowCount > 0;
    },

    // --- Settings (global key/value) ---
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

    // --- Users ---
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
      const user = { id: Number(rows[0].id), email: rows[0].email, role: rows[0].role };
      await pool.query(
        `INSERT INTO subscriptions (user_id, plan_id) VALUES ($1, $2)
           ON CONFLICT (user_id) DO NOTHING`,
        [user.id, DEFAULT_PLAN_ID]
      );
      return user;
    },

    // --- Plans & subscriptions (schema only) ---
    async listPlans() {
      const { rows } = await pool.query(
        'SELECT id, name, price_cents, max_polls, max_participants, features FROM plans ORDER BY price_cents'
      );
      return rows.map((r) => ({
        id: r.id,
        name: r.name,
        price_cents: r.price_cents,
        max_polls: r.max_polls,
        max_participants: r.max_participants,
        features: r.features || {},
      }));
    },
    async getSubscriptionByUser(userId) {
      const { rows } = await pool.query(
        `SELECT id, user_id, plan_id, status, provider, provider_customer_id,
                provider_subscription_id, current_period_end, created_at
           FROM subscriptions WHERE user_id = $1`,
        [Number(userId)]
      );
      if (!rows[0]) return null;
      const r = rows[0];
      return {
        id: Number(r.id),
        userId: Number(r.user_id),
        planId: r.plan_id,
        status: r.status,
        provider: r.provider,
        providerCustomerId: r.provider_customer_id,
        providerSubscriptionId: r.provider_subscription_id,
        currentPeriodEnd: asMs(r.current_period_end),
        createdAt: asMs(r.created_at),
      };
    },
    async setSubscriptionPlan(userId, planId) {
      await pool.query(
        `INSERT INTO subscriptions (user_id, plan_id, status) VALUES ($1, $2, 'active')
           ON CONFLICT (user_id) DO UPDATE SET plan_id = EXCLUDED.plan_id, status = 'active'`,
        [Number(userId), planId]
      );
      return this.getSubscriptionByUser(userId);
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

/** Aggregate one poll's submissions. */
async function computeData(pollId) {
  return aggregate(await store.all(pollId));
}

// ---------------------------------------------------------------------------
// Participation code (per poll)
// ---------------------------------------------------------------------------

/** Generate a short, human-friendly code (no ambiguous characters). */
function generateCode() {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let out = '';
  const bytes = crypto.randomBytes(6);
  for (let i = 0; i < 6; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

/**
 * A poll's code is only required once its owner has set one. When required,
 * the supplied code must match (case-insensitively).
 */
function codeAcceptedForPoll(poll, supplied) {
  const active = poll && poll.participationCode;
  if (!active) return true; // participation open until a code is set
  return String(supplied || '').trim().toUpperCase() === String(active).toUpperCase();
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
// Routing helpers
// ---------------------------------------------------------------------------

/** Serialize submission rows to CSV for organizer export. */
function toCsv(rows) {
  const header = ['id', 'country_id', 'country_name', 'community', 'participant_id'];
  const esc = (v) => {
    const s = String(v == null ? '' : v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const lines = [header.join(',')];
  for (const r of rows) {
    lines.push(
      [r.id, r.countryId, r.countryName, r.community, r.participantId].map(esc).join(',')
    );
  }
  return lines.join('\n');
}

/** The poll behind the legacy global routes (`/api/data`, `/`). */
async function defaultPoll() {
  return store.getPollBySlug('global-pulse');
}

/** Whether a user may manage a poll (its owner or the platform super admin). */
function canManagePoll(user, poll) {
  return !!user && !!poll && (poll.ownerId === user.id || user.role === ROLE_SUPER);
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

    // --- API: subscription plans (public, for pricing display) ---
    if (req.method === 'GET' && pathname === '/api/plans') {
      sendJson(res, 200, { plans: await store.listPlans() });
      return;
    }

    // --- API: the current user's subscription (schema only) ---
    if (pathname === '/api/subscription') {
      if (!user) {
        sendJson(res, 401, { error: 'Please sign in.' });
        return;
      }
      if (req.method === 'GET') {
        sendJson(res, 200, { subscription: await store.getSubscriptionByUser(user.id) });
        return;
      }
      if (req.method === 'POST') {
        const data = JSON.parse((await readBody(req)) || '{}');
        const plans = await store.listPlans();
        const planId = String(data.planId || '');
        if (!plans.some((p) => p.id === planId)) {
          sendJson(res, 400, { error: 'Unknown plan.' });
          return;
        }
        const sub = await store.setSubscriptionPlan(user.id, planId);
        sendJson(res, 200, { subscription: sub });
        return;
      }
      sendJson(res, 405, { error: 'Method not allowed' });
      return;
    }

    // --- API: organizer poll collection ---
    if (pathname === '/api/polls') {
      if (!user) {
        sendJson(res, 401, { error: 'Please sign in.' });
        return;
      }
      if (req.method === 'GET') {
        sendJson(res, 200, { polls: await store.listPollsByOwner(user.id) });
        return;
      }
      if (req.method === 'POST') {
        const data = JSON.parse((await readBody(req)) || '{}');
        const title = cleanDisplay(data.title || '');
        if (!title) {
          sendJson(res, 400, { error: 'A poll title is required.' });
          return;
        }
        if (title.length > 120) {
          sendJson(res, 400, { error: 'Poll title is too long.' });
          return;
        }
        const poll = await store.createPoll({
          ownerId: user.id,
          title,
          description: data.description || '',
        });
        sendJson(res, 201, { poll });
        return;
      }
      sendJson(res, 405, { error: 'Method not allowed' });
      return;
    }

    // --- API: a single poll (owner/super admin) ---
    const pollMgmt = pathname.match(/^\/api\/polls\/(\d+)(?:\/(archive|code|export))?$/);
    if (pollMgmt) {
      if (!user) {
        sendJson(res, 401, { error: 'Please sign in.' });
        return;
      }
      const poll = await store.getPollById(Number(pollMgmt[1]));
      if (!poll) {
        sendJson(res, 404, { error: 'Poll not found.' });
        return;
      }
      if (!canManagePoll(user, poll)) {
        sendJson(res, 403, { error: 'You do not manage this poll.' });
        return;
      }
      const action = pollMgmt[2];

      // /api/polls/:id/archive
      if (action === 'archive') {
        if (req.method !== 'POST') {
          sendJson(res, 405, { error: 'Method not allowed' });
          return;
        }
        sendJson(res, 200, { poll: await store.archivePoll(poll.id) });
        return;
      }

      // /api/polls/:id/code
      if (action === 'code') {
        if (req.method === 'POST') {
          const updated = await store.updatePoll(poll.id, { participationCode: generateCode() });
          sendJson(res, 200, { poll: updated });
          return;
        }
        if (req.method === 'DELETE') {
          const updated = await store.updatePoll(poll.id, { participationCode: null });
          sendJson(res, 200, { poll: updated });
          return;
        }
        sendJson(res, 405, { error: 'Method not allowed' });
        return;
      }

      // /api/polls/:id/export -> CSV
      if (action === 'export') {
        if (req.method !== 'GET') {
          sendJson(res, 405, { error: 'Method not allowed' });
          return;
        }
        const rows = await store.all(poll.id);
        const csv = toCsv(rows);
        res.writeHead(200, {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="${poll.slug}.csv"`,
          'Cache-Control': 'no-store',
        });
        res.end(csv);
        return;
      }

      // /api/polls/:id  (GET / PUT / DELETE)
      if (req.method === 'GET') {
        sendJson(res, 200, { poll });
        return;
      }
      if (req.method === 'PUT') {
        const data = JSON.parse((await readBody(req)) || '{}');
        const fields = {};
        if (data.title != null) {
          const title = cleanDisplay(data.title);
          if (!title) {
            sendJson(res, 400, { error: 'A poll title is required.' });
            return;
          }
          if (title.length > 120) {
            sendJson(res, 400, { error: 'Poll title is too long.' });
            return;
          }
          fields.title = title;
        }
        if (data.description != null) fields.description = data.description;
        sendJson(res, 200, { poll: await store.updatePoll(poll.id, fields) });
        return;
      }
      if (req.method === 'DELETE') {
        await store.deletePoll(poll.id);
        sendJson(res, 200, { ok: true });
        return;
      }
      sendJson(res, 405, { error: 'Method not allowed' });
      return;
    }

    // --- API: poll-scoped participant routes: /api/poll/:slug/... ---
    if (pathname.startsWith('/api/poll/')) {
      const rest = pathname.slice('/api/poll/'.length);
      const slash = rest.indexOf('/');
      const slug = slash < 0 ? rest : rest.slice(0, slash);
      const sub = slash < 0 ? '' : rest.slice(slash + 1);
      const poll = await store.getPollBySlug(slug);
      if (!poll) {
        sendJson(res, 404, { error: 'Poll not found.' });
        return;
      }

      // Public aggregated data for the presentation page.
      if (sub === 'data' && req.method === 'GET') {
        sendJson(res, 200, await computeData(poll.id));
        return;
      }

      // Public config: title, status, whether a code is required.
      if (sub === 'config' && req.method === 'GET') {
        sendJson(res, 200, {
          title: poll.title,
          status: poll.status,
          participationRequired: !!poll.participationCode,
        });
        return;
      }

      // The logged-in user's own submissions in this poll.
      if (sub === 'mine' && req.method === 'GET') {
        if (!user) {
          sendJson(res, 200, { submissions: [] });
          return;
        }
        const mine = await store.listByParticipant(poll.id, String(user.id));
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

      // Submit a community entry to this poll.
      if (sub === 'submit' && req.method === 'POST') {
        if (!user) {
          sendJson(res, 401, { error: 'Please sign in to participate.' });
          return;
        }
        if (poll.status === 'archived') {
          sendJson(res, 403, { error: 'This poll has been archived and is read-only.' });
          return;
        }
        const data = JSON.parse((await readBody(req)) || '{}');
        const err = validateEntry(data);
        if (err) {
          sendJson(res, 400, { error: err });
          return;
        }
        if (!codeAcceptedForPoll(poll, data.code)) {
          sendJson(res, 403, { error: 'Invalid participation code.', code: 'BAD_CODE' });
          return;
        }
        const community = cleanDisplay(data.community);
        const id = await store.add({
          pollId: poll.id,
          participantId: String(user.id),
          countryId: String(data.countryId).trim(),
          countryName: String(data.countryName).trim(),
          community,
          normalized: normalizeCommunity(community),
        });
        sendJson(res, 201, { ok: true, id, data: await computeData(poll.id) });
        return;
      }

      // Edit or withdraw one's own submission in this poll.
      const subEdit = sub.match(/^submission\/(\d+)$/);
      if (subEdit) {
        if (!user) {
          sendJson(res, 401, { error: 'Please sign in.' });
          return;
        }
        const id = Number(subEdit[1]);
        const record = await store.getById(id);
        const owns =
          record && record.pollId === poll.id && record.participantId === String(user.id);

        if (req.method === 'DELETE') {
          if (!owns) {
            sendJson(res, 403, { error: 'You can only withdraw your own submission.' });
            return;
          }
          if (poll.status === 'archived') {
            sendJson(res, 403, { error: 'This poll has been archived and is read-only.' });
            return;
          }
          await store.remove(id);
          sendJson(res, 200, { ok: true, data: await computeData(poll.id) });
          return;
        }
        if (req.method === 'PUT') {
          if (!owns) {
            sendJson(res, 403, { error: 'You can only edit your own submission.' });
            return;
          }
          if (poll.status === 'archived') {
            sendJson(res, 403, { error: 'This poll has been archived and is read-only.' });
            return;
          }
          const data = JSON.parse((await readBody(req)) || '{}');
          const verr = validateEntry(data);
          if (verr) {
            sendJson(res, 400, { error: verr });
            return;
          }
          if (!codeAcceptedForPoll(poll, data.code)) {
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
          sendJson(res, 200, { ok: true, data: await computeData(poll.id) });
          return;
        }
        sendJson(res, 405, { error: 'Method not allowed' });
        return;
      }

      sendJson(res, 404, { error: 'Not found' });
      return;
    }

    // --- API: legacy global data alias (default poll) ---
    if (req.method === 'GET' && pathname === '/api/data') {
      const poll = await defaultPoll();
      sendJson(res, 200, poll ? await computeData(poll.id) : aggregate([]));
      return;
    }

    // --- API: legacy config alias (default poll) ---
    if (req.method === 'GET' && pathname === '/api/config') {
      const poll = await defaultPoll();
      sendJson(res, 200, { participationRequired: !!(poll && poll.participationCode) });
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
      '/dashboard': 'dashboard.html',
      '/login': 'login.html',
      '/signup': 'signup.html',
    };
    if (req.method === 'GET' && Object.prototype.hasOwnProperty.call(PAGES, pathname)) {
      serveStatic(req, res, '/' + PAGES[pathname]);
      return;
    }

    // Per-poll presentation: /p/:slug -> present.html (slug read client-side).
    if (req.method === 'GET' && /^\/p\/[a-z0-9-]+$/.test(pathname)) {
      serveStatic(req, res, '/present.html');
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
