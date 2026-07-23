import { Router } from 'express';
import { config } from '../config.js';
import { query } from '../db/pool.js';
import { verifyCredentials } from '../lib/discord.js';
import { guildMetadata, invalidateGuildCache } from '../lib/gate.js';
import { mask } from '../lib/secretbox.js';
import {
  current,
  loadSettings,
  markAwaitingAdminClaim,
  saveDiscordSettings,
  verifySetupToken,
} from '../lib/settings.js';

export const setupRouter = Router();

const SETUP_COOKIE = 'quorum_setup';

/**
 * Authorises a setup request.
 *
 * Two ways in: an existing admin re-running setup, or a valid one-time token
 * for the first run, when no admin can exist yet.
 *
 * @param {import('express').Request} req
 * @returns {Promise<{via: 'admin'|'token', token?: object}|null>} How the caller
 *   was authorised, or null when they were not.
 */
async function authorise(req) {
  // Setup is super-admin only; a plain admin cannot see or change it.
  if (req.user?.isSuperAdmin) return { via: 'admin' };

  const token = await verifySetupToken(req.cookies?.[SETUP_COOKIE] ?? req.body?.token);
  if (token) return { via: 'token', token };

  return null;
}

/**
 * Reports whether setup is needed, for the frontend to route on.
 *
 * Deliberately reveals nothing sensitive: no credential values, and no signal
 * about whether a supplied token was close to correct.
 */
setupRouter.get('/state', (req, res) => {
  const settings = current();

  res.json({
    configured: settings.configured,
    source: settings.source,
    readOnly: settings.readOnly,
    error: settings.error,
    guildName: settings.configured ? settings.guildName : null,
    canManage: Boolean(req.user?.isSuperAdmin),
  });
});

/** Exchanges a setup token for a short-lived setup session. */
setupRouter.post('/token', async (req, res, next) => {
  try {
    const token = await verifySetupToken(req.body?.token);
    if (!token) return res.status(403).json({ error: 'That setup link is invalid or expired.' });

    res.cookie(SETUP_COOKIE, String(req.body.token), {
      httpOnly: true,
      secure: config.publicUrl.startsWith('https://'),
      sameSite: 'lax',
      maxAge: 60 * 60 * 1000,
      path: '/',
    });

    return res.json({ ok: true });
  } catch (error) {
    return next(error);
  }
});

/**
 * Returns the current configuration for the wizard to prefill.
 *
 * Secrets come back masked; the wizard treats a blank secret field on save as
 * "keep the existing value", so they never need to leave the server.
 */
setupRouter.get('/current', async (req, res, next) => {
  try {
    if (!(await authorise(req))) return res.status(403).json({ error: 'Not authorised.' });

    const settings = current();

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
      configured: settings.configured,
      readOnly: settings.readOnly,
      source: settings.source,
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
 * A blank or masked secret means "unchanged", so re-running setup does not
 * force the operator to paste credentials they have already given.
 *
 * @param {object} body Request body from the wizard.
 * @returns {{clientId: string, clientSecret: string, botToken: string, guildId: string}}
 */
function mergeWithStored(body) {
  const settings = current();
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
setupRouter.post('/test', async (req, res, next) => {
  try {
    if (!(await authorise(req))) return res.status(403).json({ error: 'Not authorised.' });

    const result = await verifyCredentials(mergeWithStored(req.body ?? {}));
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
setupRouter.post('/save', async (req, res, next) => {
  try {
    const auth = await authorise(req);
    if (!auth) return res.status(403).json({ error: 'Not authorised.' });

    const settings = current();
    if (settings.readOnly) {
      return res.status(409).json({
        error:
          'Discord is configured through environment variables, so it cannot be changed here. ' +
          'Remove DISCORD_* from the environment to manage it from this panel.',
      });
    }

    const values = mergeWithStored(req.body ?? {});
    const verified = await verifyCredentials(values);
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
      req.user?.id ?? null,
    );
    invalidateGuildCache();

    // First run: the holder of the setup token becomes admin by signing in with
    // Discord next, which is now possible because credentials exist.
    let claimUrl = null;
    if (auth.via === 'token') {
      await markAwaitingAdminClaim(auth.token.id);
      claimUrl = '/api/auth/login';
    }

    return res.json({
      ok: true,
      guild: verified.guild,
      warnings: verified.problems,
      claimUrl,
    });
  } catch (error) {
    return next(error);
  }
});

/**
 * Clears the stored configuration and issues a fresh setup token.
 *
 * Kept admin-only and separate from save, so "start over" is a deliberate act
 * rather than something a half-finished wizard can trigger.
 */
setupRouter.post('/reset', async (req, res, next) => {
  try {
    if (!req.user?.isSuperAdmin) {
      return res.status(403).json({ error: 'Super administrator access required.' });
    }
    if (current().readOnly) {
      return res.status(409).json({ error: 'Configuration is pinned to the environment.' });
    }

    await query('DELETE FROM app_settings WHERE id = true');
    await loadSettings();
    invalidateGuildCache();

    await query(
      `INSERT INTO audit_log (actor_id, action, target_type, target_id)
       VALUES ($1, 'setup.reset', 'settings', 'app_settings')`,
      [req.user.id],
    );

    return res.json({ ok: true });
  } catch (error) {
    return next(error);
  }
});

export { SETUP_COOKIE };
