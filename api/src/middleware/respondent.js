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

// A Discord identity a respondent has proved, for surveys gated on the guild.
// It is emphatically not a session: it names no account, carries no tier, and
// `loadSession` never looks at it. Its own HMAC context and its own cookie name
// keep it from being replayed as one, and it authorises nothing on its own -
// every gated request re-checks membership with the bot token before the survey
// opens.
const DISCORD_COOKIE = 'quorum_guild';
// Longer than an admin session precisely because it is worth less. Expiring it
// early would only ask a respondent to sign in again mid-survey; it cannot go
// stale in a way that matters, since membership is verified per request.
const DISCORD_MAX_AGE_MS = 30 * 86_400_000;

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
 * Signs a proved Discord identity.
 *
 * The expiry is inside the signature rather than left to the cookie's own
 * lifetime, so a copied value stops working on the server's clock instead of
 * the browser's.
 *
 * @param {string} payload `discordId.expiresMs`.
 * @returns {string} URL-safe signature.
 */
const signDiscord = (payload) =>
  createHmac('sha256', config.sessionSecret)
    .update(`respondent-discord:${payload}`)
    .digest('base64url');

/**
 * Records that this browser has proved ownership of a Discord account.
 *
 * Creates no `users` row, no session, and no server-side state of any kind:
 * a respondent is not an account, and v1.2.0 refuses unknown Discord ids on the
 * admin path for good reason. All this says is "the OAuth round trip for this
 * id completed here", and every gated survey still checks the guild itself.
 *
 * @param {import('express').Response} res
 * @param {string} discordId The verified Discord user id.
 * @returns {void}
 */
export function issueRespondentDiscord(res, discordId) {
  const payload = `${discordId}.${Date.now() + DISCORD_MAX_AGE_MS}`;
  res.cookie(DISCORD_COOKIE, `${payload}.${signDiscord(payload)}`, {
    httpOnly: true,
    secure: config.publicUrl.startsWith('https://'),
    sameSite: 'lax',
    maxAge: DISCORD_MAX_AGE_MS,
    path: '/',
  });
}

/**
 * Reads and verifies the proved-Discord cookie.
 *
 * @param {import('express').Request} req
 * @returns {string|null} The Discord id, or null when absent, forged, or expired.
 */
function respondentDiscordId(req) {
  // A Discord id is digits and the expiry is digits, so the three parts are
  // unambiguous.
  const parts = String(req.cookies?.[DISCORD_COOKIE] ?? '').split('.');
  if (parts.length !== 3) return null;

  const [discordId, expires, signature] = parts;
  const expected = signDiscord(`${discordId}.${expires}`);

  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  if (!/^\d+$/.test(expires) || Number(expires) < Date.now()) return null;

  return discordId;
}

/**
 * Populates `req.respondentId`, minting the cookie on first contact, and
 * `req.respondentDiscordId` when one has been proved.
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
    req.respondentDiscordId = respondentDiscordId(req);
    return next();
  };
}

export const RESPONDENT_COOKIE = COOKIE;
export const RESPONDENT_DISCORD_COOKIE = DISCORD_COOKIE;
