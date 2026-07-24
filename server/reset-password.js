#!/usr/bin/env node
'use strict';

/**
 * Reset an account's password from the command line.
 *
 * There is no email provider wired up, so accounts cannot self-serve a reset.
 * This is the recovery path for a locked-out account (typically the super
 * admin). It targets whichever store the server itself would use: PostgreSQL
 * when DATABASE_URL is set, otherwise the JSON file at DATA_DIR/data.json.
 *
 * Usage:
 *   node server/reset-password.js --list
 *   node server/reset-password.js <email> [new-password]
 *
 * With no password, a strong one is generated and printed. Run it wherever the
 * store lives — locally for the file store, or in the Render shell (which has
 * DATABASE_URL set) for production.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { hashPassword } = require('./passwords');
const { sslFor } = require('./pgconfig');

const DATA_DIR = process.env.DATA_DIR || __dirname;
const DATA_FILE = path.join(DATA_DIR, 'data.json');
const SQLITE_PATH = process.env.SQLITE_PATH || path.join(DATA_DIR, 'data.db');
const MIN_PASSWORD_LENGTH = 6; // matches the signup rule in index.js

function usage() {
  console.error(
    [
      'Reset a Global Pulse account password.',
      '',
      'Usage:',
      '  node server/reset-password.js --list             List accounts',
      '  node server/reset-password.js <email> [password] Reset a password',
      '',
      'With no password, a random one is generated and printed.',
    ].join('\n')
  );
}

/** A readable, strong random password. */
function generatePassword() {
  return crypto.randomBytes(12).toString('base64url');
}

// --- Postgres ---------------------------------------------------------------
async function withPostgres(fn) {
  const { Pool } = require('pg');
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: sslFor(process.env.DATABASE_URL),
  });
  try {
    return await fn(pool);
  } finally {
    await pool.end();
  }
}

const pgStore = {
  label: 'PostgreSQL (DATABASE_URL)',
  list: () =>
    withPostgres(async (pool) => {
      const { rows } = await pool.query('SELECT email, role FROM users ORDER BY id');
      return rows;
    }),
  setPassword: (email, passwordHash) =>
    withPostgres(async (pool) => {
      const { rowCount } = await pool.query(
        'UPDATE users SET password_hash = $1 WHERE email = $2',
        [passwordHash, email]
      );
      return rowCount > 0;
    }),
};

// --- SQLite -----------------------------------------------------------------
function withSqlite(fn) {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(SQLITE_PATH);
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

const sqliteStore = {
  label: 'SQLite at ' + SQLITE_PATH,
  list: async () =>
    withSqlite((db) => db.prepare('SELECT email, role FROM users ORDER BY id').all()),
  setPassword: async (email, passwordHash) =>
    withSqlite(
      (db) =>
        db
          .prepare('UPDATE users SET password_hash = ? WHERE email = ?')
          .run(passwordHash, email).changes > 0
    ),
};

// --- JSON file --------------------------------------------------------------
function readFileStore() {
  return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
}

const fileStore = {
  label: 'JSON file at ' + DATA_FILE,
  // A running server keeps users in memory and rewrites the whole file on its
  // next save, which would silently undo a reset made behind its back.
  warning:
    'Stop the server before resetting, then start it again.\n' +
    'A running server still holds the old password in memory and will\n' +
    'overwrite this change the next time it saves.',
  list: async () => (readFileStore().users || []).map((u) => ({ email: u.email, role: u.role })),
  setPassword: async (email, passwordHash) => {
    const data = readFileStore();
    const user = (data.users || []).find((u) => u.email === email);
    if (!user) return false;
    user.passwordHash = passwordHash;
    // Write via a temp file + rename, matching the server's atomic save.
    const tmp = DATA_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, DATA_FILE);
    return true;
  },
};

// --- Main -------------------------------------------------------------------
async function main() {
  const args = process.argv.slice(2);
  if (!args.length || args[0] === '--help' || args[0] === '-h') {
    usage();
    process.exit(1);
  }

  // Mirror the server's storage selection so we target the same data.
  let store;
  if (process.env.DATABASE_URL && /^postgres(ql)?:\/\//.test(process.env.DATABASE_URL)) {
    store = pgStore;
  } else if (process.env.GP_STORAGE === 'file') {
    store = fileStore;
  } else {
    store = sqliteStore;
  }
  console.log('Store: ' + store.label);

  if (args[0] === '--list') {
    const users = await store.list();
    if (!users.length) {
      console.log('No accounts yet. The first person to sign up becomes the super admin.');
      return;
    }
    for (const u of users) console.log(' - ' + u.email + '  (' + u.role + ')');
    return;
  }

  // The server lowercases emails on signup and login, so match that here.
  const email = String(args[0]).trim().toLowerCase();
  const password = args[1] || generatePassword();
  if (password.length < MIN_PASSWORD_LENGTH) {
    console.error('Password must be at least ' + MIN_PASSWORD_LENGTH + ' characters.');
    process.exit(1);
  }

  const ok = await store.setPassword(email, hashPassword(password));
  if (!ok) {
    console.error('No account found for ' + email + '. Run --list to see accounts.');
    process.exit(1);
  }

  console.log('Password updated for ' + email);
  if (!args[1]) console.log('New password: ' + password);
  console.log('Existing sessions stay valid until they expire.');
  if (store.warning) console.log('\n' + store.warning);
}

main().catch((err) => {
  console.error('Reset failed: ' + err.message);
  process.exit(1);
});
