import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { config } from '../config.js';

/**
 * Authenticated encryption for credentials held in the database.
 *
 * The key is derived from SESSION_SECRET rather than being its own environment
 * variable, so a deployment still needs exactly one secret in its environment.
 * The consequence is deliberate: rotating SESSION_SECRET makes stored Discord
 * credentials unreadable and the setup wizard has to be run again. Callers get
 * a clear failure for that case rather than a crash.
 */

const KEY = Buffer.from(
  hkdfSync('sha256', Buffer.from(config.sessionSecret), Buffer.alloc(0), 'quorum-settings-v1', 32),
);

const IV_BYTES = 12;

export class DecryptError extends Error {
  constructor() {
    super('Stored credentials could not be decrypted. Run setup again.');
    this.name = 'DecryptError';
  }
}

/**
 * Encrypts a string for storage.
 *
 * @param {string|null} plaintext Value to protect; null passes through.
 * @returns {Buffer|null} `iv || authTag || ciphertext`, or null.
 */
export function seal(plaintext) {
  if (plaintext === null || plaintext === undefined || plaintext === '') return null;

  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', KEY, iv);
  const ciphertext = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);

  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
}

/**
 * Decrypts a value produced by `seal`.
 *
 * @param {Buffer|null} sealed Stored bytes.
 * @returns {string|null} The plaintext, or null when nothing was stored.
 * @throws {DecryptError} When the key no longer matches or the bytes are damaged.
 */
export function open(sealed) {
  if (!sealed) return null;

  try {
    const buffer = Buffer.from(sealed);
    const iv = buffer.subarray(0, IV_BYTES);
    const tag = buffer.subarray(IV_BYTES, IV_BYTES + 16);
    const ciphertext = buffer.subarray(IV_BYTES + 16);

    const decipher = createDecipheriv('aes-256-gcm', KEY, iv);
    decipher.setAuthTag(tag);

    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch {
    throw new DecryptError();
  }
}

/**
 * Masks a secret for display in the admin panel.
 *
 * @param {string|null} secret
 * @returns {string|null} Last four characters behind a fixed-width mask.
 */
export function mask(secret) {
  if (!secret) return null;
  return `${'*'.repeat(8)}${String(secret).slice(-4)}`;
}
