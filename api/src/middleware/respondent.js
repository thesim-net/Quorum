import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';

/**
 * Anonymous respondent identity.
 *
 * Taking a survey needs no account: each browser carries a random id in a
 * long-lived signed cookie, and `respondentHash` derives the per-survey
 * fingerprint from it. That keeps one-response-per-browser semantics and the
 * anonymise/rotate-key flow working without any sign-in.
 *
 * The id is signed with its own HMAC context so a session cookie can never be
 * replayed as a respondent id or vice versa.
 */

const COOKIE = 'quorum_rid';
// Long-lived on purpose: clearing it is what would let someone answer twice.
// 400 days is the ceiling modern browsers accept.
const MAX_AGE_MS = 400 * 86_400_000;

/**
 * Signs a respondent id.
 *
 * @param {string} id Respondent uuid.
 * @returns {string} Cookie value in `id.signature` form.
 */
function sign(id) {
  const signature = createHmac('sha256', config.sessionSecret)
    .update(`respondent:${id}`)
    .digest('base64url');
  return `${id}.${signature}`;
}

/**
 * Verifies a signed cookie value.
 *
 * @param {string} value Raw cookie value.
 * @returns {string|null} The respondent id, or null when the signature is invalid.
 */
function unsign(value) {
  const [id, signature] = String(value).split('.');
  if (!id || !signature) return null;

  const expected = createHmac('sha256', config.sessionSecret)
    .update(`respondent:${id}`)
    .digest('base64url');

  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  return id;
}

/**
 * Populates `req.respondentId`, minting the cookie on first contact.
 *
 * @returns {import('express').RequestHandler} Express middleware.
 */
export function ensureRespondent() {
  return (req, res, next) => {
    let id = unsign(req.cookies?.[COOKIE] ?? '');

    if (!id) {
      id = randomUUID();
      res.cookie(COOKIE, sign(id), {
        httpOnly: true,
        secure: config.publicUrl.startsWith('https://'),
        sameSite: 'lax',
        maxAge: MAX_AGE_MS,
        path: '/',
      });
    }

    req.respondentId = id;
    return next();
  };
}

export const RESPONDENT_COOKIE = COOKIE;
