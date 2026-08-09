import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { config } from '../config.js';
import { query } from '../db/pool.js';
import { hashPassword, verifyPassword } from '../lib/passwords.js';
import { current, effectiveAuthMethods } from '../lib/settings.js';
import { PLUGINS, isPluginEnabled } from '../lib/plugins.js';
import { TIERS, sanitisePermissions } from '../lib/permissionSet.js';
import { endSession, requireMember, startSession } from '../middleware/session.js';
import { challengeRequired, issueChallenge } from '../plugins/twofactor/twofactor.js';

export const authRouter = Router();

// Password guessing gets its own, tighter ceiling on top of the general
// /api/auth limiter.
const loginLimiter = rateLimit({
  windowMs: 60_000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
});

// A well-formed hash of nothing anyone can type, verified against when the
// username is unknown so that path costs the same as a real check.
const DUMMY_HASH =
  'scrypt$16384$8$1$xtPm/4XR722L/e9XE9xkACL7Q9vhz+e7X8tjFjRSlu4=$Boco63O+i+ndm9g/XDNB5VCgSzgW+VTxdt46GArnYKBcX9zP7FIdaSd2Zuqy/+ZSeqEwh+PiEdHII39fTE4Sgw==';

// Local sign-in names: the same shape the admin panel enforces on creation.
const USERNAME_PATTERN = /^[a-zA-Z0-9._-]{3,32}$/;

/**
 * Whether a username is free among accounts that hold a local password.
 *
 * The local-username uniqueness index only covers password holders, so a name
 * mirrored from Discord on a passwordless account never blocks a local one.
 *
 * @param {string} username Candidate username.
 * @param {string} selfId The caller's user id, excluded from the check.
 * @returns {Promise<boolean>} True when the name is available.
 */
async function usernameAvailable(username, selfId) {
  const { rows } = await query(
    'SELECT 1 FROM users WHERE lower(username) = lower($1) AND password_hash IS NOT NULL AND id <> $2',
    [username, selfId],
  );
  return rows.length === 0;
}

/**
 * Reports which sign-in methods are available, for the sign-in page.
 *
 * Public by design: the page has to know what to offer before anyone is
 * signed in, and the toggles reveal nothing sensitive.
 */
authRouter.get('/methods', (_req, res) => {
  res.json({ methods: effectiveAuthMethods() });
});

/**
 * Signs in with a local username and password.
 *
 * The response never says which of the two was wrong. Failures are audited so
 * a guessing run leaves a trail. Accounts under 2FA get a challenge cookie
 * instead of a session; POST /2fa completes the sign-in.
 */
authRouter.post('/login', loginLimiter, async (req, res, next) => {
  try {
    if (!effectiveAuthMethods().local) {
      return res.status(403).json({ error: 'Password sign-in is not enabled.' });
    }

    const username = String(req.body?.username ?? '').trim();
    const password = String(req.body?.password ?? '');
    if (!username || !password) {
      return res.status(400).json({ error: 'Enter a username and password.' });
    }

    const { rows } = await query(
      'SELECT * FROM users WHERE lower(username) = lower($1) AND password_hash IS NOT NULL',
      [username],
    );
    const user = rows[0] ?? null;

    // The hash is verified even for an unknown username, so the response time
    // does not reveal which usernames exist.
    const ok = await verifyPassword(password, user?.password_hash ?? DUMMY_HASH);
    if (!user || !ok) {
      await query(
        `INSERT INTO audit_log (actor_id, action, target_type, target_id, meta)
         VALUES (NULL, 'auth.login_failed', 'user', NULL, $1)`,
        [{ username }],
      );
      return res.status(401).json({ error: 'Wrong username or password.' });
    }

    if (challengeRequired(user)) {
      issueChallenge(res, user.id);
      return res.json({ ok: true, twofactor: true });
    }

    await query('UPDATE users SET last_login_at = now() WHERE id = $1', [user.id]);
    await startSession(res, { id: user.id }, []);
    return res.json({ ok: true, twofactor: false });
  } catch (error) {
    return next(error);
  }
});

/**
 * Sets or changes the caller's own password.
 *
 * Changing an existing password takes the current one, so a walked-away-from
 * session is not enough to take the account over. Setting an INITIAL password
 * (an account that has none, e.g. a Discord admin) needs no current password;
 * it may set a username in the same step, and requires one when the account has
 * none, since local sign-in needs a unique name.
 */
authRouter.post('/password', requireMember, async (req, res, next) => {
  try {
    const currentPassword = String(req.body?.currentPassword ?? '');
    const newPassword = String(req.body?.newPassword ?? '');
    const requestedUsername =
      req.body?.username != null ? String(req.body.username).trim() : null;

    const { rows } = await query('SELECT password_hash, username FROM users WHERE id = $1', [
      req.user.id,
    ]);
    const row = rows[0] ?? {};
    const hasPassword = Boolean(row.password_hash);

    if (newPassword.length < 8 || newPassword.length > 200) {
      return res.status(400).json({ error: 'Passwords need at least 8 characters.' });
    }

    // Changing an existing password proves the old one; the initial set does not.
    if (hasPassword && !(await verifyPassword(currentPassword, row.password_hash))) {
      return res.status(403).json({ error: 'The current password is wrong.' });
    }

    // Decide the username the password will sign in with.
    let username = row.username;
    if (requestedUsername !== null) {
      if (!USERNAME_PATTERN.test(requestedUsername)) {
        return res.status(400).json({
          error: 'Usernames are 3-32 characters: letters, numbers, dots, dashes, underscores.',
        });
      }
      username = requestedUsername;
    }

    // Setting an initial password puts the row into the local-username index, so
    // a username is needed and must be free among password holders.
    if (!hasPassword) {
      if (!username) {
        return res.status(400).json({ error: 'Choose a username to sign in with.' });
      }
      if (!(await usernameAvailable(username, req.user.id))) {
        return res.status(409).json({ error: 'That username is already taken.' });
      }
    } else if (requestedUsername !== null && !(await usernameAvailable(username, req.user.id))) {
      return res.status(409).json({ error: 'That username is already taken.' });
    }

    await query('UPDATE users SET password_hash = $2, username = COALESCE($3, username) WHERE id = $1', [
      req.user.id,
      await hashPassword(newPassword),
      username,
    ]);

    await query(
      `INSERT INTO audit_log (actor_id, action, target_type, target_id, meta)
       VALUES ($1, $2, 'user', $3, $4)`,
      [req.user.id, hasPassword ? 'auth.password_change' : 'auth.password_set', req.user.id, {}],
    );
    return res.json({ ok: true });
  } catch (error) {
    return next(error);
  }
});

/**
 * Sets or changes the caller's own local username.
 *
 * Available to everyone, including Discord-authenticated admins, so a local
 * username can be chosen independently of the password step.
 */
authRouter.post('/username', requireMember, async (req, res, next) => {
  try {
    const username = String(req.body?.username ?? '').trim();
    if (!USERNAME_PATTERN.test(username)) {
      return res.status(400).json({
        error: 'Usernames are 3-32 characters: letters, numbers, dots, dashes, underscores.',
      });
    }
    if (!(await usernameAvailable(username, req.user.id))) {
      return res.status(409).json({ error: 'That username is already taken.' });
    }

    await query('UPDATE users SET username = $2 WHERE id = $1', [req.user.id, username]);
    await query(
      `INSERT INTO audit_log (actor_id, action, target_type, target_id)
       VALUES ($1, 'auth.username_change', 'user', $2)`,
      [req.user.id, req.user.id],
    );
    return res.json({ ok: true });
  } catch (error) {
    return next(error);
  }
});

/**
 * Signs in without an account, for local preview.
 *
 * Registered only when the bypass is active, so on a real deployment this path
 * does not exist at all rather than existing and refusing.
 */
if (config.devAuthBypass) {
  authRouter.post('/dev-login', async (req, res, next) => {
    try {
      const discordId = String(req.body?.discordId ?? '900000000000000001');
      const username = String(req.body?.username ?? 'previewuser');

      // `tier` mirrors the requested role so preview can exercise each one;
      // note the bypass itself also forces super admin at request time.
      const tier = req.body?.admin === false ? TIERS.NONE : TIERS.SUPER;
      const { rows } = await query(
        `INSERT INTO users (discord_id, username, display_name, tier, permissions, last_login_at)
              VALUES ($1, $2, $3, $4, $5, now())
         ON CONFLICT (discord_id) DO UPDATE
              SET username = EXCLUDED.username,
                  tier = EXCLUDED.tier,
                  permissions = EXCLUDED.permissions,
                  last_login_at = now()
           RETURNING id`,
        [discordId, username, username, tier, sanitisePermissions(req.body?.permissions)],
      );

      await startSession(res, { id: rows[0].id }, []);
      return res.json({ ok: true, username });
    } catch (error) {
      return next(error);
    }
  });
}

/** Ends the caller's session. */
authRouter.post('/logout', async (req, res, next) => {
  try {
    await endSession(req, res);
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

/**
 * Returns the signed-in account, or null when signed out.
 *
 * Role ids are deliberately not exposed to the client; gate decisions are made
 * server-side and surfaced as a boolean per survey.
 */
authRouter.get('/me', (req, res) => {
  const plugins = {
    discord: isPluginEnabled(current().plugins, PLUGINS.DISCORD),
    twofactor: isPluginEnabled(current().plugins, PLUGINS.TWOFACTOR),
  };

  // The wordmark animation default is public so a signed-out visitor can
  // resolve it before any account is loaded.
  const asciiAnimationDefault = current().asciiAnimationDefault;

  if (!req.user) {
    return res.json({ user: null, plugins, devAuthBypass: config.devAuthBypass, asciiAnimationDefault });
  }

  return res.json({
    plugins,
    devAuthBypass: config.devAuthBypass,
    asciiAnimationDefault,
    user: {
      id: req.user.id,
      username: req.user.username,
      displayName: req.user.displayName,
      avatar: req.user.avatar,
      discordId: req.user.discordId,
      hasPassword: req.user.hasPassword,
      hasUsername: Boolean(req.user.username),
      // An admin without a local password must set one before using the panel,
      // so flipping to local-only sign-in can never lock a Discord admin out.
      // The dev bypass has no real credentials, so it is exempt.
      mustSetCredentials:
        req.user.isAdmin && !req.user.hasPassword && !config.devAuthBypass,
      isAdmin: req.user.isAdmin,
      isSuperAdmin: req.user.isSuperAdmin,
      tier: req.user.tier,
      // The saved skin/mode, so it is applied on sign-in from any device.
      theme: req.user.prefs?.theme ?? null,
      // The saved wordmark-animation preference, or null when unset.
      asciiAnimation:
        typeof req.user.prefs?.asciiAnimation === 'boolean' ? req.user.prefs.asciiAnimation : null,
    },
  });
});

/**
 * Saves a per-user interface preference.
 *
 * Currently just the wordmark animation toggle; validated to a boolean and
 * written into users.prefs so it follows the account across devices.
 */
authRouter.put('/prefs', requireMember, async (req, res, next) => {
  try {
    if (typeof req.body?.asciiAnimation !== 'boolean') {
      return res.status(400).json({ error: 'Unknown preference.' });
    }

    await query(
      `UPDATE users SET prefs = jsonb_set(prefs, '{asciiAnimation}', $2::jsonb) WHERE id = $1`,
      [req.user.id, JSON.stringify(req.body.asciiAnimation)],
    );
    return res.json({ ok: true });
  } catch (error) {
    return next(error);
  }
});

/** Known skins and modes, so an arbitrary value cannot be stored. */
const THEME_SKINS = new Set(['default', 'github', 'obsidian', 'high-contrast']);
const THEME_MODES = new Set(['light', 'dark']);

/**
 * Saves the caller's skin and mode preference.
 *
 * Requires a signed-in account; the values are validated against the known
 * skins and modes so nothing unexpected is ever persisted or echoed back.
 */
authRouter.put('/theme', requireMember, async (req, res, next) => {
  try {
    const skin = req.body?.skin;
    const mode = req.body?.mode;
    if (!THEME_SKINS.has(skin) || !THEME_MODES.has(mode)) {
      return res.status(400).json({ error: 'Unknown skin or mode.' });
    }

    await query(
      `UPDATE users SET prefs = jsonb_set(prefs, '{theme}', $2::jsonb) WHERE id = $1`,
      [req.user.id, JSON.stringify({ skin, mode })],
    );
    return res.json({ ok: true });
  } catch (error) {
    return next(error);
  }
});

/**
 * Legacy OAuth callback path.
 *
 * Older Discord applications registered `/api/auth/callback` as their redirect
 * URL, so it forwards to the plugin's callback rather than breaking them.
 */
authRouter.get('/callback', (req, res) => {
  const search = req.originalUrl.split('?')[1] ?? '';
  res.redirect(`/api/auth/discord/callback${search ? `?${search}` : ''}`);
});
