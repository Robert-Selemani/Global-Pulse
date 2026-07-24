'use strict';

/**
 * Password hashing, shared by the server and the reset-password CLI.
 *
 * Lives in its own module so the CLI can hash a password without requiring
 * server/index.js, which starts an HTTP server as a side effect of loading.
 */

const crypto = require('crypto');

const SCHEME = 'scrypt';
const KEYLEN = 64;

/** Hash a plaintext password as `scrypt$<salt hex>$<hash hex>`. */
function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, KEYLEN);
  return SCHEME + '$' + salt.toString('hex') + '$' + hash.toString('hex');
}

/** Check a plaintext password against a stored `scrypt$salt$hash` string. */
function verifyPassword(password, stored) {
  try {
    const [scheme, saltHex, hashHex] = String(stored).split('$');
    if (scheme !== SCHEME) return false;
    const hash = Buffer.from(hashHex, 'hex');
    const test = crypto.scryptSync(String(password), Buffer.from(saltHex, 'hex'), hash.length);
    return crypto.timingSafeEqual(hash, test);
  } catch (_) {
    return false;
  }
}

module.exports = { hashPassword, verifyPassword };
