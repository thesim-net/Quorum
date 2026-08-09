import { Router } from 'express';
import { config } from '../../config.js';
import { query } from '../../db/pool.js';
import { mask } from '../../lib/secretbox.js';
import { current, effectiveAuthMethods } from '../../lib/settings.js';
import { PLUGINS, isPluginEnabled } from '../../lib/plugins.js';
import { PERMISSIONS, TIERS, sanitisePermissions } from '../../lib/permissionSet.js';
import {
  newStateToken,
  requireAdmin,
  requirePermission,
  startSession,
} from '../../middleware/session.js';
import { challengeRequired, issueChallenge } from '../twofactor/twofactor.js';
import * as discord from './discord.js';
import { guildMetadata, invalidateGuildCache } from './gate.js';
import { resetDiscordSettings, saveDiscordSettings } from './settings.js';

const STATE_COOKIE = 'quorum_state';

/** Whether Discord sign-in can be offered right now. */
const loginAvailable = () => effectiveAuthMethods().discord;

/** Whether the plugin is enabled and a server is connected. */
const pluginReady = () =>
  isPluginEnabled(current().plugins, PLUGINS.DISCORD) && current().discord.configured;

/**
 * Records an admin action for the audit trail.
 *
 * @param {string} actorId User id of the acting admin.
 * @param {string} action Action name.
 * @param {string} targetType Entity type acted on.
 * @param {string} targetId Entity id.
 * @param {object} meta Extra detail worth keeping.
 * @returns {Promise<void>}
 */
async function audit(actorId, action, targetType, targetId, meta = {}) {
  await query(
    `INSERT INTO audit_log (actor_id, action, target_type, target_id, meta)
     VALUES ($1, $2, $3, $4, $5)`,
    [actorId, action, targetType, targetId, meta],
  );
}

// ---------------------------------------------------------------------------
// OAuth sign-in, mounted at /api/auth/discord
// ---------------------------------------------------------------------------

export const discordAuthRouter = Router();

/**
 * Starts the Discord OAuth flow.
 *
 * The CSRF state token is stored in a short-lived cookie and compared on the
 * callback, so a forged callback cannot complete a login.
 */
discordAuthRouter.get('/login', (req, res) => {
  if (!loginAvailable()) return res.redirect('/login?error=discord_unavailable');

  const state = newStateToken();

  res.cookie(STATE_COOKIE, state, {
    httpOnly: true,
    secure: config.publicUrl.startsWith('https://'),
    sameSite: 'lax',
    maxAge: 10 * 60 * 1000,
    path: '/',
  });

  return res.redirect(discord.authorizeUrl(state));
});

/**
 * Completes the OAuth flow.
 *
 * Guild membership is checked with the bot token rather than the member's OAuth
 * token, so a token minted by another application cannot be replayed here. When
 * the twofactor plugin requires it, the session is withheld until the code is
 * entered.
 */
discordAuthRouter.get('/callback', async (req, res, next) => {
  try {
    if (!loginAvailable()) return res.redirect('/login?error=discord_unavailable');

    const { code, state } = req.query;
    const expected = req.cookies?.[STATE_COOKIE];
    res.clearCookie(STATE_COOKIE, { path: '/' });

    if (!code || !state || state !== expected) {
      return res.redirect('/login?error=invalid_state');
    }

    const token = await discord.exchangeCode(String(code));
    const profile = await discord.currentUser(token.access_token);

    const member = await discord.guildMember(profile.id);
    if (!member) return res.redirect('/login?error=not_in_guild');

    const { rows } = await query(
      `INSERT INTO users (discord_id, username, display_name, avatar, tier, last_login_at)
            VALUES ($1, $2, $3, $4, $5, now())
       ON CONFLICT (discord_id) DO UPDATE
            -- A local password means the username was chosen for local sign-in,
            -- so it is kept rather than overwritten from Discord each login.
            SET username = CASE WHEN users.password_hash IS NULL
                                THEN EXCLUDED.username ELSE users.username END,
                display_name = EXCLUDED.display_name,
                avatar = EXCLUDED.avatar,
                -- A stored tier is never lowered by a later login. Role and
                -- channel derived access is recomputed per request instead.
                tier = GREATEST(users.tier, EXCLUDED.tier),
                last_login_at = now()
         RETURNING id, discord_id, tier, totp_required, totp_secret_enc, totp_confirmed_at`,
      [
        profile.id,
        profile.username,
        member.nick ?? profile.global_name ?? null,
        profile.avatar,
        TIERS.NONE,
      ],
    );

    // Admin accounts under 2FA get a challenge instead of a session; the code
    // page completes the sign-in.
    if (challengeRequired(rows[0])) {
      issueChallenge(res, rows[0].id);
      return res.redirect('/login?twofactor=1');
    }

    await startSession(res, { id: rows[0].id }, member.roles);
    return res.redirect('/');
  } catch (error) {
    return next(error);
  }
});

// ---------------------------------------------------------------------------
// Settings and admin helpers, mounted at /api/plugin/discord
// ---------------------------------------------------------------------------

export const discordAdminRouter = Router();

/** Connection summary for the admin panel. */
discordAdminRouter.get('/status', requireAdmin, (_req, res) => {
  const settings = current();
  res.json({
    enabled: isPluginEnabled(settings.plugins, PLUGINS.DISCORD),
    configured: settings.discord.configured,
    source: settings.discord.source,
    readOnly: settings.discord.readOnly,
    error: settings.discord.error,
    guildName: settings.discord.configured ? settings.discord.guildName : null,
  });
});

/**
 * Returns the current configuration for the connection wizard to prefill.
 *
 * Secrets come back masked; the wizard treats a blank secret field on save as
 * "keep the existing value", so they never need to leave the server.
 */
discordAdminRouter.get('/settings', requireAdmin, async (_req, res, next) => {
  try {
    const settings = current().discord;

    // When already connected, hand back the guild's roles and channels so the
    // admin-access selectors can be edited without re-testing the credentials.
    // A Discord hiccup here just omits the lists; the wizard still works.
    let roles = [];
    let channels = [];
    if (settings.configured) {
      try {
        const meta = await guildMetadata();
        roles = meta.roles
          .filter((role) => role.id !== meta.guild.id)
          .sort((a, b) => b.position - a.position)
          .map((role) => ({ id: role.id, name: role.name }));
        channels = meta.channels
          .filter((channel) => [0, 5, 15].includes(channel.type))
          .sort((a, b) => a.position - b.position)
          .map((channel) => ({ id: channel.id, name: channel.name }));
      } catch {
        roles = [];
        channels = [];
      }
    }

    return res.json({
      enabled: isPluginEnabled(current().plugins, PLUGINS.DISCORD),
      configured: settings.configured,
      readOnly: settings.readOnly,
      source: settings.source,
      error: settings.error,
      guild: settings.configured ? { name: settings.guildName } : null,
      roles,
      channels,
      values: settings.configured
        ? {
            clientId: settings.clientId,
            clientSecret: mask(settings.clientSecret),
            botToken: mask(settings.botToken),
            guildId: settings.guildId,
            guildName: settings.guildName,
            adminRoleIds: settings.adminRoleIds,
            adminChannelIds: settings.adminChannelIds,
          }
        : null,
    });
  } catch (error) {
    return next(error);
  }
});

/**
 * Merges submitted values with the stored ones.
 *
 * A blank or masked secret means "unchanged", so reconnecting does not force
 * the operator to paste credentials they have already given.
 *
 * @param {object} body Request body from the wizard.
 * @returns {{clientId: string, clientSecret: string, botToken: string, guildId: string}}
 */
function mergeWithStored(body) {
  const settings = current().discord;
  const keep = (submitted, stored) =>
    !submitted || String(submitted).startsWith('****') ? stored ?? '' : String(submitted).trim();

  return {
    clientId: String(body.clientId ?? settings.clientId ?? '').trim(),
    guildId: String(body.guildId ?? settings.guildId ?? '').trim(),
    clientSecret: keep(body.clientSecret, settings.clientSecret),
    botToken: keep(body.botToken, settings.botToken),
  };
}

/** Tests credentials against Discord without saving anything. */
discordAdminRouter.post('/settings/test', requireAdmin, async (req, res, next) => {
  try {
    const result = await discord.verifyCredentials(mergeWithStored(req.body ?? {}));
    return res.json(result);
  } catch (error) {
    return next(error);
  }
});

/**
 * Verifies and persists the configuration.
 *
 * Saving is refused unless the credentials actually work, so a deployment can
 * never be left pointing at a server the bot cannot reach.
 */
discordAdminRouter.post('/settings', requireAdmin, async (req, res, next) => {
  try {
    const settings = current().discord;
    if (settings.readOnly) {
      return res.status(409).json({
        error:
          'Discord is configured through environment variables, so it cannot be changed here. ' +
          'Remove DISCORD_* from the environment to manage it from this panel.',
      });
    }

    const values = mergeWithStored(req.body ?? {});
    const verified = await discord.verifyCredentials(values);
    if (!verified.ok) {
      return res.status(400).json({ error: verified.problems[0], problems: verified.problems });
    }

    const adminRoleIds = Array.isArray(req.body?.adminRoleIds)
      ? req.body.adminRoleIds.map(String)
      : [];
    const adminChannelIds = Array.isArray(req.body?.adminChannelIds)
      ? req.body.adminChannelIds.map(String)
      : [];

    await saveDiscordSettings(
      { ...values, guildName: verified.guild.name, adminRoleIds, adminChannelIds },
      req.user.id,
    );
    invalidateGuildCache();

    await audit(req.user.id, 'discord.configure', 'settings', 'app_settings', {
      guildId: values.guildId,
    });

    return res.json({ ok: true, guild: verified.guild, warnings: verified.problems });
  } catch (error) {
    return next(error);
  }
});

/**
 * Clears the stored configuration.
 *
 * Kept separate from save, so disconnecting a server is a deliberate act
 * rather than something a half-finished wizard can trigger.
 */
discordAdminRouter.post('/settings/reset', requireAdmin, async (req, res, next) => {
  try {
    if (current().discord.readOnly) {
      return res.status(409).json({ error: 'Configuration is pinned to the environment.' });
    }

    await resetDiscordSettings();
    invalidateGuildCache();
    await audit(req.user.id, 'discord.reset', 'settings', 'app_settings');

    return res.json({ ok: true });
  } catch (error) {
    return next(error);
  }
});

/** Lists the guild's roles and text channels so gates can be configured. */
discordAdminRouter.get(
  '/guild',
  requirePermission(PERMISSIONS.SURVEYS_WRITE),
  async (req, res, next) => {
    try {
      if (!pluginReady()) {
        return res.status(409).json({ error: 'The Discord plugin is not connected to a server.' });
      }

      const meta = await guildMetadata(req.query.refresh === '1');
      if (req.query.refresh === '1') invalidateGuildCache();

      return res.json({
        guild: { id: meta.guild.id, name: meta.guild.name },
        roles: meta.roles
          .filter((role) => role.id !== meta.guild.id)
          .sort((a, b) => b.position - a.position)
          .map((role) => ({ id: role.id, name: role.name, color: role.color })),
        channels: meta.channels
          // Text, announcement, and forum channels only; voice cannot gate a survey.
          .filter((channel) => [0, 5, 15].includes(channel.type))
          .sort((a, b) => a.position - b.position)
          .map((channel) => ({ id: channel.id, name: channel.name, type: channel.type })),
      });
    } catch (error) {
      return next(error);
    }
  },
);

/**
 * Grants admin access to a Discord user id.
 *
 * The id is checked against the guild first, so a typo cannot silently create
 * an admin account for somebody who is not in the server.
 */
discordAdminRouter.post('/admins', requireAdmin, async (req, res, next) => {
  try {
    if (!pluginReady()) {
      return res.status(409).json({ error: 'The Discord plugin is not connected to a server.' });
    }

    const discordId = String(req.body?.discordId ?? '').trim();
    if (!/^\d{17,20}$/.test(discordId)) {
      return res.status(400).json({ error: 'That does not look like a Discord user ID.' });
    }

    let member;
    try {
      member = await discord.guildMember(discordId);
    } catch {
      return res.status(502).json({ error: 'Could not reach Discord to check that account.' });
    }
    if (!member) {
      return res.status(404).json({ error: 'That user is not a member of the server.' });
    }

    // A super admin holds everything; a plain admin holds only what was
    // ticked. Granting nothing is refused, so the list never shows someone who
    // cannot actually do anything.
    const superAdmin = req.body?.superAdmin === true;
    const permissions = superAdmin ? [] : sanitisePermissions(req.body?.permissions);
    if (!superAdmin && permissions.length === 0) {
      return res.status(400).json({ error: 'Choose at least one permission.' });
    }

    const profile = member.user ?? {};
    const { rows } = await query(
      `INSERT INTO users (discord_id, username, display_name, avatar, tier, permissions)
            VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (discord_id) DO UPDATE
            SET tier = EXCLUDED.tier,
                permissions = EXCLUDED.permissions,
                username = COALESCE(EXCLUDED.username, users.username),
                display_name = COALESCE(EXCLUDED.display_name, users.display_name)
         RETURNING id, username`,
      [
        discordId,
        profile.username ?? `user-${discordId.slice(-4)}`,
        member.nick ?? profile.global_name ?? null,
        profile.avatar ?? null,
        superAdmin ? TIERS.SUPER : TIERS.ADMIN,
        permissions,
      ],
    );

    await audit(req.user.id, 'admin.grant', 'user', rows[0].id, {
      discordId,
      superAdmin,
      permissions,
      method: 'discord',
    });
    return res.status(201).json({ ok: true, username: rows[0].username });
  } catch (error) {
    return next(error);
  }
});
