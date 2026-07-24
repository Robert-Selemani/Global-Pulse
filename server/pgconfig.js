'use strict';

/**
 * Postgres connection config, shared by the server and the reset-password CLI
 * so both connect to the same database on the same terms.
 */

const { URL } = require('url');

/**
 * Decide the `ssl` option for a connection string. External hosts (Render's
 * public database URL) carry a domain and need SSL; localhost and Render's
 * internal host do not.
 */
function sslFor(connectionString) {
  try {
    const host = new URL(connectionString).hostname;
    if (host && host !== 'localhost' && host !== '127.0.0.1' && host.includes('.')) {
      return { rejectUnauthorized: false };
    }
  } catch (_) {
    /* fall through to no SSL */
  }
  return false;
}

module.exports = { sslFor };
