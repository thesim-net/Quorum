import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Time-based one-time passwords, RFC 6238 over RFC 4226.
 *
 * SHA-1, 6 digits, 30-second steps: the parameters every authenticator app
 * ships with. Implemented on node's crypto directly so no dependency handles
 * the second factor.
 */

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const STEP_SECONDS = 30;
const DIGITS = 6;

/**
 * Encodes a buffer as unpadded RFC 4648 base32, the alphabet TOTP secrets use.
 *
 * @param {Buffer} buffer Bytes to encode.
 * @returns {string} Base32 text without padding.
 */
export function base32Encode(buffer) {
  let bits = 0;
  let value = 0;
  let out = '';

  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];

  return out;
}

/**
 * Decodes base32 text back into bytes.
 *
 * Case-insensitive, and tolerant of padding and whitespace so a secret pasted
 * from an authenticator app round-trips.
 *
 * @param {string} text Base32 text.
 * @returns {Buffer} Decoded bytes.
 * @throws {Error} When the text contains a character outside the alphabet.
 */
export function base32Decode(text) {
  const cleaned = String(text).toUpperCase().replace(/[=\s]/g, '');

  let bits = 0;
  let value = 0;
  const out = [];

  for (const char of cleaned) {
    const index = ALPHABET.indexOf(char);
    if (index === -1) throw new Error(`Invalid base32 character: ${char}`);
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }

  return Buffer.from(out);
}

/**
 * Computes an HOTP code (RFC 4226).
 *
 * @param {Buffer} secret Shared secret bytes.
 * @param {number|bigint} counter Moving factor.
 * @param {number} digits Code length.
 * @returns {string} Zero-padded decimal code.
 */
export function hotp(secret, counter, digits = DIGITS) {
  const moving = Buffer.alloc(8);
  moving.writeBigUInt64BE(BigInt(counter));

  const digest = createHmac('sha1', secret).update(moving).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const code =
    ((digest[offset] & 0x7f) << 24) |
    (digest[offset + 1] << 16) |
    (digest[offset + 2] << 8) |
    digest[offset + 3];

  return String(code % 10 ** digits).padStart(digits, '0');
}

/**
 * Computes the TOTP code for a moment in time.
 *
 * @param {Buffer} secret Shared secret bytes.
 * @param {{timeMs?: number, stepSeconds?: number, digits?: number}} options
 * @returns {string} The current code.
 */
export function totp(secret, { timeMs = Date.now(), stepSeconds = STEP_SECONDS, digits = DIGITS } = {}) {
  return hotp(secret, Math.floor(timeMs / 1000 / stepSeconds), digits);
}

/**
 * Verifies a submitted code, allowing adjacent steps for clock drift.
 *
 * @param {Buffer} secret Shared secret bytes.
 * @param {string} code Submitted code.
 * @param {{timeMs?: number, stepSeconds?: number, digits?: number, window?: number}} options
 *   `window` is how many steps either side of now are accepted.
 * @returns {boolean} True when the code matches.
 */
export function verifyTotp(
  secret,
  code,
  { timeMs = Date.now(), stepSeconds = STEP_SECONDS, digits = DIGITS, window = 1 } = {},
) {
  const submitted = String(code ?? '').replace(/\s+/g, '');
  if (!new RegExp(`^\\d{${digits}}$`).test(submitted)) return false;

  const counter = Math.floor(timeMs / 1000 / stepSeconds);
  let matched = false;
  for (let offset = -window; offset <= window; offset += 1) {
    if (counter + offset < 0) continue;
    const expected = hotp(secret, counter + offset, digits);
    // Every candidate is compared so the timing does not reveal which step, if
    // any, was the match.
    if (timingSafeEqual(Buffer.from(expected), Buffer.from(submitted))) matched = true;
  }
  return matched;
}

/**
 * Builds the otpauth:// URI an authenticator app enrols from.
 *
 * @param {string} accountName Label shown in the app, e.g. the username.
 * @param {string} secretBase32 The shared secret, base32 encoded.
 * @returns {string} The enrolment URI.
 */
export function otpauthUri(accountName, secretBase32) {
  return `otpauth://totp/Quorum:${encodeURIComponent(accountName)}?secret=${secretBase32}&issuer=Quorum`;
}
