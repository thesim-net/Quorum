import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';
import { query } from '../db/pool.js';
import { current } from '../lib/settings.js';
import { PLUGINS, isPluginEnabled } from '../lib/plugins.js';
import { can, effectivePermissions, isSuper, TIERS } from '../lib/permissionSet.js';
import { discordTier, refreshSessionRoles } from '../plugins/discord/session.js';

const COOKIE = 'quorum_sid';

/**
 * Signs a session id so a forged cookie cannot name someone else's session.
 *
 * @param {string} sessionId Session uuid.
 * @returns {string} Cookie value in `id.signature` form.
 */
function sign(sessionId) {
  const signature = createHmac('sha256', config.sessionSecret).update(sessionId).digest('base64url');
  return `${sessionId}.${signature}`;
}

/**
 * Verifies a signed cookie value.
 *
 * @param {string} value Raw cookie value.
 * @returns {string|null} The session id, or null when the signature is invalid.
 */
function unsign(value) {
  const [sessionId, signature] = String(value).split('.');
  if (!sessionId || !signature) return null;

  const expected = createHmac('sha256', config.sessionSecret)
    .update(sessionId)
    .digest('base64url');

  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  return sessionId;
}

/**
 * Combines a user's stored tier with whatever their sign-in method contributes.
 *
 * @param {string} storedTier The users.tier column.
 * @param {string} pluginTier Tier contributed by an auth plugin, if any.
 * @returns {string} The effective tier.
 */
export function resolveTier(storedTier, pluginTier = TIERS.NONE) {
  // Local preview has no accounts to read grants from, so the bypass grants
  // the top tier rather than leaving the panel unreachable.
  if (config.devAuthBypass) return TIERS.SUPER;

  if (storedTier === TIERS.SUPER || pluginTier === TIERS.SUPER) return TIERS.SUPER;
  if (storedTier === TIERS.ADMIN || pluginTier === TIERS.ADMIN) return TIERS.ADMIN;
  return TIERS.NONE;
}

/**
 * Creates a session for a user and sets the cookie.
 *
 * @param {import('express').Response} res
 * @param {{id: string}} user Persisted user row.
 * @param {string[]} roleIds Discord roles held at login; empty for local accounts.
 * @returns {Promise<string>} The new session id.
 */
export async function startSession(res, user, roleIds = []) {
  const expiresAt = new Date(Date.now() + config.sessionTtlDays * 86_400_000);

  const { rows } = await query(
    `INSERT INTO sessions (user_id, role_ids, expires_at)
     VALUES ($1, $2, $3) RETURNING id`,
    [user.id, roleIds, expiresAt],
  );

  res.cookie(COOKIE, sign(rows[0].id), {
    httpOnly: true,
    secure: config.publicUrl.startsWith('https://'),
    sameSite: 'lax',
    expires: expiresAt,
    path: '/',
  });

  return rows[0].id;
}

/**
 * Clears the caller's session, both server-side and in the browser.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @returns {Promise<void>}
 */
export async function endSession(req, res) {
  const sessionId = unsign(req.cookies?.[COOKIE] ?? '');
  if (sessionId) await query('DELETE FROM sessions WHERE id = $1', [sessionId]);
  res.clearCookie(COOKIE, { path: '/' });
}

/**
 * Populates `req.user` from the session cookie when one is present and valid.
 *
 * Never rejects a request on its own; routes that need an account use
 * `requireMember`. For Discord-backed accounts, roles are refreshed through the
 * discord plugin once the cached snapshot ages past `ROLE_CACHE_SECONDS`.
 *
 * @returns {import('express').RequestHandler} Express middleware.
 */
export function loadSession() {
  return async (req, _res, next) => {
    req.user = null;

    try {
      const sessionId = unsign(req.cookies?.[COOKIE] ?? '');
      if (!sessionId) return next();

      const { rows } = await query(
        `SELECT s.id, s.role_ids, s.roles_synced_at, s.expires_at,
                u.id AS user_id, u.discord_id, u.username, u.display_name, u.avatar,
                u.tier, u.permissions, u.prefs,
                u.password_hash IS NOT NULL AS has_password
           FROM sessions s
           JOIN users u ON u.id = s.user_id
          WHERE s.id = $1 AND s.expires_at > now()`,
        [sessionId],
      );
      if (rows.length === 0) return next();

      const session = rows[0];
      let roleIds = session.role_ids;
      let pluginTier = TIERS.NONE;

      const settings = current();
      const discordActive =
        Boolean(session.discord_id) &&
        isPluginEnabled(settings.plugins, PLUGINS.DISCORD) &&
        settings.discord.configured;

      if (discordActive) {
        const ageMs = Date.now() - new Date(session.roles_synced_at).getTime();
        if (!config.devAuthBypass && ageMs > config.roleCacheSeconds * 1000) {
          // A Discord outage must not log everyone out, so fall back to the
          // cached snapshot when the refresh fails.
          try {
            const refreshed = await refreshSessionRoles(session, session.discord_id);
            if (refreshed === null) return next();
            roleIds = refreshed;
          } catch (error) {
            console.warn(`Role refresh failed for ${session.discord_id}: ${error.message}`);
          }
        }

        pluginTier = await discordTier(session, roleIds);
      }

      const tier = resolveTier(session.tier, pluginTier);

      req.user = {
        id: session.user_id,
        discordId: session.discord_id,
        username: session.username,
        displayName: session.display_name,
        avatar: session.avatar,
        roleIds,
        tier,
        hasPassword: session.has_password,
        isSuperAdmin: isSuper({ tier }),
        // Retained for readability at call sites: "can reach the panel".
        isAdmin: tier !== TIERS.NONE,
        permissions: effectivePermissions({ tier, permissions: session.permissions }),
        prefs: session.prefs ?? {},
      };
    } catch (error) {
      console.error('Session load failed:', error);
    }

    return next();
  };
}

/**
 * Rejects the request unless someone is signed in.
 *
 * @type {import('express').RequestHandler}
 */
export function requireMember(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Sign in to continue.' });
  return next();
}

/**
 * Rejects the request unless the caller is a full administrator.
 *
 * Reserved for actions that are not grantable: managing other admins, and
 * changing how the deployment is configured.
 *
 * @type {import('express').RequestHandler}
 */
export function requireAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Sign in to continue.' });
  if (!req.user.isSuperAdmin) {
    return res.status(403).json({ error: 'Super administrator access required.' });
  }
  return next();
}

/**
 * Rejects the request unless the caller can reach the admin panel at all.
 *
 * A limited admin holds at least one permission; what they may actually do is
 * enforced per route by `requirePermission`.
 *
 * @type {import('express').RequestHandler}
 */
export function requirePanel(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Sign in to continue.' });
  if (req.user.tier === TIERS.NONE) {
    return res.status(403).json({ error: 'Admin access required.' });
  }
  return next();
}

/**
 * Builds middleware that requires one specific permission.
 *
 * @param {string} permission One of PERMISSIONS.
 * @returns {import('express').RequestHandler} Express middleware.
 */
export function requirePermission(permission) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Sign in to continue.' });
    if (!can(req.user, permission)) {
      return res.status(403).json({
        error: 'You do not have permission to do that.',
        required: permission,
      });
    }
    return next();
  };
}

/**
 * Generates an opaque OAuth state token.
 *
 * @returns {string} URL-safe random token.
 */
export const newStateToken = () => randomBytes(24).toString('base64url');

export const SESSION_COOKIE = COOKIE;
export { sign as signSessionId, unsign as unsignSessionId };
