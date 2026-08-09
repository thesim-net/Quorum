import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { config } from '../../config.js';
import { current } from '../../lib/settings.js';
import { PLUGINS, isPluginEnabled } from '../../lib/plugins.js';

/**
 * Two-factor login challenges.
 *
 * After a successful primary sign-in (password or Discord), an account under
 * 2FA gets a short-lived signed challenge cookie instead of a session; posting
 * a valid code exchanges it for the real session. Disabling the plugin
 * suspends challenges but keeps enrolment data intact.
 */

const COOKIE = 'quorum_2fa';
const TTL_MS = 5 * 60_000;
const SECRET_BYTES = 20;

/** Whether the plugin is switched on. */
export const twofactorEnabled = () => isPluginEnabled(current().plugins, PLUGINS.TWOFACTOR);

/**
 * Whether an account must pass a 2FA challenge before its session starts.
 *
 * Required accounts are challenged even before they finish enrolling: the
 * challenge flow lets them enrol on the spot, so requiring 2FA can never be
 * bypassed by simply not setting it up.
 *
 * @param {{totp_required: boolean, totp_secret_enc: Buffer|null,
 *   totp_confirmed_at: Date|null}} userRow
 * @returns {boolean} True when a challenge must be issued.
 */
export function challengeRequired(userRow) {
  if (!twofactorEnabled()) return false;
  if (userRow.totp_required) return true;
  return Boolean(userRow.totp_secret_enc && userRow.totp_confirmed_at);
}

/**
 * Signs a challenge payload.
 *
 * The HMAC context is distinct from the session cookie's, so neither can be
 * replayed as the other.
 *
 * @param {string} payload `userId.expiresMs`.
 * @returns {string} URL-safe signature.
 */
const sign = (payload) =>
  createHmac('sha256', config.sessionSecret).update(`twofactor:${payload}`).digest('base64url');

/**
 * Issues a challenge cookie for a user who passed primary auth.
 *
 * @param {import('express').Response} res
 * @param {string} userId
 * @returns {void}
 */
export function issueChallenge(res, userId) {
  const payload = `${userId}.${Date.now() + TTL_MS}`;
  res.cookie(COOKIE, `${payload}.${sign(payload)}`, {
    httpOnly: true,
    secure: config.publicUrl.startsWith('https://'),
    sameSite: 'lax',
    maxAge: TTL_MS,
    path: '/',
  });
}

/**
 * Reads and verifies the challenge cookie.
 *
 * @param {import('express').Request} req
 * @returns {string|null} The challenged user's id, or null when absent,
 *   forged, or expired.
 */
export function readChallenge(req) {
  const parts = String(req.cookies?.[COOKIE] ?? '').split('.');
  if (parts.length !== 3) return null;

  const [userId, expires, signature] = parts;
  const expected = sign(`${userId}.${expires}`);

  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  if (!/^\d+$/.test(expires) || Number(expires) < Date.now()) return null;

  return userId;
}

/**
 * Clears the challenge cookie.
 *
 * @param {import('express').Response} res
 * @returns {void}
 */
export function clearChallenge(res) {
  res.clearCookie(COOKIE, { path: '/' });
}

/**
 * Generates a fresh shared secret for enrolment.
 *
 * @returns {Buffer} 20 random bytes, the RFC 4226 recommended length.
 */
export const newSecret = () => randomBytes(SECRET_BYTES);

export const CHALLENGE_COOKIE = COOKIE;
