import { Router } from 'express';
import { config } from '../config.js';
import { query } from '../db/pool.js';
import * as discord from '../lib/discord.js';
import { claimAdminToken, verifySetupToken } from '../lib/settings.js';
import { SETUP_COOKIE } from './setup.js';
import { TIERS, sanitisePermissions } from '../lib/permissionSet.js';
import { endSession, newStateToken, requireMember, startSession } from '../middleware/session.js';

export const authRouter = Router();

const STATE_COOKIE = 'quorum_state';

/**
 * Starts the Discord OAuth flow.
 *
 * The CSRF state token is stored in a short-lived cookie and compared on the
 * callback, so a forged callback cannot complete a login.
 */
authRouter.get('/login', (req, res) => {
  const state = newStateToken();

  res.cookie(STATE_COOKIE, state, {
    httpOnly: true,
    secure: config.publicUrl.startsWith('https://'),
    sameSite: 'lax',
    maxAge: 10 * 60 * 1000,
    path: '/',
  });

  res.redirect(discord.authorizeUrl(state));
});

/**
 * Completes the OAuth flow.
 *
 * Guild membership is checked with the bot token rather than the member's OAuth
 * token, so a token minted by another application cannot be replayed here.
 */
authRouter.get('/callback', async (req, res, next) => {
  try {
    const { code, state } = req.query;
    const expected = req.cookies?.[STATE_COOKIE];
    res.clearCookie(STATE_COOKIE, { path: '/' });

    if (!code || !state || state !== expected) {
      return res.redirect('/?error=invalid_state');
    }

    const token = await discord.exchangeCode(String(code));
    const profile = await discord.currentUser(token.access_token);

    const member = await discord.guildMember(profile.id);
    if (!member) return res.redirect('/?error=not_in_guild');

    // The operator who completed setup claims admin with their first sign-in.
    // The token is consumed atomically, so the claim can only ever happen once.
    let claimedAdmin = false;
    const setupToken = await verifySetupToken(req.cookies?.[SETUP_COOKIE]);
    if (setupToken?.awaiting_admin_claim) {
      claimedAdmin = await claimAdminToken(setupToken.id);
      res.clearCookie(SETUP_COOKIE, { path: '/' });
    }

    const { rows } = await query(
      `INSERT INTO users (discord_id, username, display_name, avatar, tier, last_login_at)
            VALUES ($1, $2, $3, $4, $5, now())
       ON CONFLICT (discord_id) DO UPDATE
            SET username = EXCLUDED.username,
                display_name = EXCLUDED.display_name,
                avatar = EXCLUDED.avatar,
                -- A stored tier is never lowered by a later login. Role and
                -- channel derived access is recomputed per request instead.
                tier = GREATEST(users.tier, EXCLUDED.tier),
                last_login_at = now()
         RETURNING id, discord_id`,
      [
        profile.id,
        profile.username,
        member.nick ?? profile.global_name ?? null,
        profile.avatar,
        // Completing setup mints the first super admin; everyone else starts
        // with no stored tier and is resolved from roles and channels.
        claimedAdmin ? TIERS.SUPER : TIERS.NONE,
      ],
    );

    await startSession(res, { id: rows[0].id, discordId: rows[0].discord_id }, member.roles);
    return res.redirect('/');
  } catch (error) {
    return next(error);
  }
});

/**
 * Signs in without Discord, for local preview.
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
           RETURNING id, discord_id`,
        [discordId, username, username, tier, sanitisePermissions(req.body?.permissions)],
      );

      await startSession(res, { id: rows[0].id, discordId: rows[0].discord_id }, []);
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
 * Returns the signed-in member, or null when signed out.
 *
 * Role ids are deliberately not exposed to the client; gate decisions are made
 * server-side and surfaced as a boolean per survey.
 */
authRouter.get('/me', (req, res) => {
  if (!req.user) return res.json({ user: null, devAuthBypass: config.devAuthBypass });

  return res.json({
    user: {
      id: req.user.id,
      username: req.user.username,
      displayName: req.user.displayName,
      avatar: req.user.avatar,
      discordId: req.user.discordId,
      isAdmin: req.user.isAdmin,
      isSuperAdmin: req.user.isSuperAdmin,
      tier: req.user.tier,
      // The saved skin/mode, so it is applied on sign-in from any device.
      theme: req.user.prefs?.theme ?? null,
    },
  });
});

/** Known skins and modes, so an arbitrary value cannot be stored. */
const THEME_SKINS = new Set(['default', 'github', 'obsidian', 'high-contrast']);
const THEME_MODES = new Set(['light', 'dark']);

/**
 * Saves the caller's skin and mode preference.
 *
 * Requires a signed-in member; the values are validated against the known
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
