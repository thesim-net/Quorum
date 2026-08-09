import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

/**
 * Password hashing for local accounts.
 *
 * Uses node's built-in scrypt so no dependency is added for something this
 * security-sensitive. Parameters are stored alongside each hash, so they can be
 * raised later without invalidating existing credentials.
 */

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SALT_BYTES = 32;
const KEY_BYTES = 64;

/**
 * Derives a key from a password, promisified.
 *
 * @param {string} password
 * @param {Buffer} salt
 * @param {{N: number, r: number, p: number}} params Cost parameters.
 * @returns {Promise<Buffer>} The derived key.
 */
const derive = (password, salt, { N, r, p }) =>
  new Promise((resolve, reject) => {
    scrypt(password, salt, KEY_BYTES, { N, r, p }, (error, key) =>
      error ? reject(error) : resolve(key),
    );
  });

/**
 * Hashes a password for storage.
 *
 * @param {string} password
 * @returns {Promise<string>} `scrypt$N$r$p$salt_b64$hash_b64`.
 */
export async function hashPassword(password) {
  const salt = randomBytes(SALT_BYTES);
  const key = await derive(String(password), salt, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  return [
    'scrypt',
    SCRYPT_N,
    SCRYPT_R,
    SCRYPT_P,
    salt.toString('base64'),
    key.toString('base64'),
  ].join('$');
}

/**
 * Checks a password against a stored hash in constant time.
 *
 * @param {string} password Candidate password.
 * @param {string|null} stored Stored `scrypt$...` string.
 * @returns {Promise<boolean>} True when the password matches.
 */
export async function verifyPassword(password, stored) {
  const parts = String(stored ?? '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

  const [, n, r, p, saltB64, hashB64] = parts;
  const params = { N: Number(n), r: Number(r), p: Number(p) };
  if (![params.N, params.r, params.p].every((v) => Number.isInteger(v) && v > 0)) return false;

  const expected = Buffer.from(hashB64, 'base64');
  if (expected.length === 0) return false;

  let key;
  try {
    key = await derive(String(password), Buffer.from(saltB64, 'base64'), params);
  } catch {
    return false;
  }
  return key.length === expected.length && timingSafeEqual(key, expected);
}

/**
 * Generates a one-time password for a newly created or reset account.
 *
 * Shown to the granting admin exactly once; the holder should change it.
 *
 * @returns {string} A random URL-safe password.
 */
export function generatePassword() {
  return randomBytes(12).toString('base64url');
}
