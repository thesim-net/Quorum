import { Router } from 'express';
import { config } from '../config.js';
import { query, transaction } from '../db/pool.js';
import { generatePassword, hashPassword } from '../lib/passwords.js';
import { current, effectiveAuthMethods, saveAuthMethods, savePlugins } from '../lib/settings.js';
import {
  aggregateRanking,
  categorise,
  formatAnswer,
  numericStats,
  toCsv,
} from '../lib/results.js';
import { deleteSurveyFiles, pathForKey } from '../lib/uploads.js';
import {
  PLUGINS,
  PLUGIN_CATALOGUE,
  isPluginEnabled,
  sanitisePlugins,
} from '../lib/plugins.js';
import { updateStatus } from '../lib/update.js';
import { requireAdmin, requirePanel, requirePermission } from '../middleware/session.js';
import {
  ALL_PERMISSIONS,
  PERMISSIONS,
  PERMISSION_LABELS,
  TIERS,
  sanitisePermissions,
} from '../lib/permissionSet.js';
import { postMessage } from '../plugins/discord/discord.js';
import { adminDirectory, hasBootstrapSupers } from '../plugins/discord/session.js';

export const adminRouter = Router();

// Reaching the panel needs at least one permission; each route then requires
// the specific one it needs.
adminRouter.use(requirePanel);

const writeSurveys = requirePermission(PERMISSIONS.SURVEYS_WRITE);
const publishSurveys = requirePermission(PERMISSIONS.SURVEYS_PUBLISH);
const deleteSurveys = requirePermission(PERMISSIONS.SURVEYS_DELETE);
const readResults = requirePermission(PERMISSIONS.RESULTS_READ);

const USERNAME_PATTERN = /^[a-zA-Z0-9._-]{3,32}$/;

/** Whether the discord plugin is enabled with a server connected. */
const discordActive = () =>
  isPluginEnabled(current().plugins, PLUGINS.DISCORD) && current().discord.configured;

/**
 * Reports whether a newer version is available.
 *
 * Super-admin only: updating is a deployment concern. The check itself is
 * cached and never fails the request.
 */
adminRouter.get('/update', requireAdmin, async (req, res, next) => {
  try {
    res.json(await updateStatus(req.query.refresh === '1'));
  } catch (error) {
    next(error);
  }
});

/** Reports the caller's own permissions, so the UI can hide what they cannot do. */
adminRouter.get('/me', (req, res) => {
  res.json({
    tier: req.user.tier,
    isSuperAdmin: req.user.isSuperAdmin,
    permissions: req.user.permissions,
    catalogue: ALL_PERMISSIONS.map((key) => ({ key, ...PERMISSION_LABELS[key] })),
  });
});

const QUESTION_TYPES = new Set([
  'short_text',
  'long_text',
  'integer',
  'single_choice',
  'multi_choice',
  'ranking',
  'boolean',
  'scale',
  'file_upload',
]);

const CHOICE_TYPES = new Set(['single_choice', 'multi_choice', 'ranking']);

/**
 * Derives what a survey is actually doing right now.
 *
 * `status` alone cannot say this: a survey set to open but with a future
 * opening time is not yet taking responses, and one past its closing time has
 * stopped without anybody touching it.
 *
 * @param {{status: string, opens_at: Date|null, closes_at: Date|null}} survey
 * @returns {'draft'|'scheduled'|'live'|'ended'|'closed'} The effective state.
 */
function liveState(survey) {
  if (survey.status === 'draft') return 'draft';
  if (survey.status === 'closed') return 'closed';

  const now = Date.now();
  if (survey.opens_at && now < new Date(survey.opens_at).getTime()) return 'scheduled';
  if (survey.closes_at && now > new Date(survey.closes_at).getTime()) return 'ended';
  return 'live';
}

/**
 * Posts an open/close announcement for a survey, if configured.
 *
 * Guarded by the plugin being enabled, a channel being set, and a one-shot
 * flag so the same event is never announced twice. On close it appends a short
 * participation summary.
 *
 * @param {string} surveyId
 * @param {'open'|'closed'} status The status just applied.
 * @returns {Promise<{posted: boolean, reason?: string, error?: string}>}
 */
async function maybeAnnounce(surveyId, status) {
  if (!isPluginEnabled(current().plugins, PLUGINS.ANNOUNCEMENTS)) {
    return { posted: false, reason: 'plugin_disabled' };
  }

  const { rows } = await query('SELECT * FROM surveys WHERE id = $1', [surveyId]);
  const survey = rows[0];
  const channelId = survey?.plugin_config?.announceChannelId;
  if (!channelId) return { posted: false, reason: 'no_channel' };

  const sentColumn = status === 'open' ? 'announce_open_sent' : 'announce_close_sent';
  if (survey[sentColumn]) return { posted: false, reason: 'already_sent' };

  const url = `${config.publicUrl}/s/${survey.slug}`;
  let content;
  if (status === 'open') {
    content = `**A new survey is open: ${survey.title}**\n${survey.description || ''}\nTake it here: ${url}`;
  } else {
    const { rows: counts } = await query(
      `SELECT count(*) FILTER (WHERE status = 'completed')::int AS completed,
              count(*)::int AS started
         FROM responses WHERE survey_id = $1`,
      [surveyId],
    );
    content =
      `**Survey closed: ${survey.title}**\n` +
      `${counts[0].completed} completed response(s) from ${counts[0].started} started. Thanks to everyone who took part.`;
  }

  await postMessage(channelId, content);
  await query(`UPDATE surveys SET ${sentColumn} = true WHERE id = $1`, [surveyId]);
  return { posted: true };
}

/**
 * Records an admin action for the audit trail.
 *
 * @param {string} actorId User id of the acting admin.
 * @param {string} action Action name, e.g. `survey.close`.
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

/**
 * Derives a URL slug from a title, with a random suffix for uniqueness.
 *
 * @param {string} title Survey title.
 * @returns {string} Slug safe for use in a path.
 */
function slugify(title) {
  const base = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
  const suffix = Math.random().toString(36).slice(2, 7);
  return `${base || 'survey'}-${suffix}`;
}

// ---------------------------------------------------------------------------
// Plugins
// ---------------------------------------------------------------------------

/**
 * Finds which open surveys use each plugin.
 *
 * "Using" means the survey has settings that only matter while it is live, so
 * disabling the plugin would change a running survey's behaviour. Raffle is an
 * on-demand action with no standing configuration, so nothing ever depends on
 * it being enabled.
 *
 * @returns {Promise<Record<string, Array<{id: string, title: string}>>>} A map
 *   of plugin key to the open surveys depending on it.
 */
async function pluginUsage() {
  const { rows } = await query(
    `SELECT s.id, s.title, s.plugin_config, s.gate_role_ids, s.gate_channel_ids,
            EXISTS (SELECT 1 FROM questions q WHERE q.survey_id = s.id AND q.config ? 'showIf')
              AS has_conditional
       FROM surveys s
      WHERE s.status = 'open'`,
  );

  const usage = {
    [PLUGINS.DISCORD]: [],
    [PLUGINS.TWOFACTOR]: [],
    [PLUGINS.ANNOUNCEMENTS]: [],
    [PLUGINS.REMINDERS]: [],
    [PLUGINS.CONDITIONAL]: [],
    [PLUGINS.QUOTAS]: [],
    [PLUGINS.RAFFLE]: [],
  };

  for (const row of rows) {
    const config = row.plugin_config ?? {};
    const entry = { id: row.id, title: row.title };

    // A survey gated by role or channel needs Discord to evaluate the gate.
    if (row.gate_role_ids.length > 0 || row.gate_channel_ids.length > 0) {
      usage[PLUGINS.DISCORD].push(entry);
    }
    if (config.announceChannelId) usage[PLUGINS.ANNOUNCEMENTS].push(entry);
    if (config.remindHoursBeforeClose !== undefined && config.remindHoursBeforeClose !== null) {
      usage[PLUGINS.REMINDERS].push(entry);
    }
    if (row.has_conditional) usage[PLUGINS.CONDITIONAL].push(entry);
    if (config.quota?.maxResponses !== undefined && config.quota?.maxResponses !== null) {
      usage[PLUGINS.QUOTAS].push(entry);
    }
  }

  return usage;
}

/** Lists the plugins, their enablement, and which open surveys depend on them. */
adminRouter.get('/plugins', requireAdmin, async (_req, res, next) => {
  try {
    const enabled = current().plugins ?? {};
    const usage = await pluginUsage();

    res.json({
      plugins: PLUGIN_CATALOGUE.map((plugin) => ({
        ...plugin,
        enabled: Boolean(enabled[plugin.key]),
        activeSurveys: usage[plugin.key] ?? [],
      })),
    });
  } catch (error) {
    next(error);
  }
});

/**
 * Updates plugin enablement.
 *
 * A plugin that an open survey depends on cannot be turned off, so a live
 * survey never loses behaviour out from under its participants. Dependencies
 * are enforced the same way: the announcement plugins cannot run without
 * discord, and discord cannot be turned off while local sign-in is.
 */
adminRouter.put('/plugins', requireAdmin, async (req, res, next) => {
  try {
    const desired = sanitisePlugins(req.body?.plugins);
    const settings = current();
    const currentPlugins = settings.plugins ?? {};
    const usage = await pluginUsage();

    for (const plugin of PLUGIN_CATALOGUE) {
      if (plugin.requires && desired[plugin.key] && !desired[plugin.requires]) {
        const dependency = PLUGIN_CATALOGUE.find((entry) => entry.key === plugin.requires);
        return res.status(409).json({
          error: `${plugin.name} needs the ${dependency.name} plugin. Enable that first.`,
          plugin: plugin.key,
          requires: plugin.requires,
        });
      }
    }

    if (currentPlugins[PLUGINS.DISCORD] && !desired[PLUGINS.DISCORD]) {
      if (settings.discord.source === 'environment') {
        return res.status(409).json({
          error:
            'Discord is pinned by DISCORD_* environment variables, so the plugin cannot be disabled here.',
          plugin: PLUGINS.DISCORD,
        });
      }
      if (!settings.authMethods.local) {
        return res.status(409).json({
          error:
            'Discord sign-in is the only enabled method. Enable local sign-in before disabling the plugin.',
          plugin: PLUGINS.DISCORD,
        });
      }
    }

    for (const plugin of PLUGIN_CATALOGUE) {
      const turningOff = currentPlugins[plugin.key] && !desired[plugin.key];
      if (turningOff && (usage[plugin.key]?.length ?? 0) > 0) {
        return res.status(409).json({
          error: `${plugin.name} is in use by ${usage[plugin.key].length} open survey(s). Close or change them before disabling it.`,
          plugin: plugin.key,
          activeSurveys: usage[plugin.key],
        });
      }
    }

    await savePlugins(desired);
    await audit(req.user.id, 'plugins.update', 'settings', 'app_settings', { plugins: desired });
    return res.json({ ok: true });
  } catch (error) {
    return next(error);
  }
});

// ---------------------------------------------------------------------------
// Sign-in methods
// ---------------------------------------------------------------------------

/** Reports the sign-in method toggles and what they resolve to right now. */
adminRouter.get('/auth-methods', requireAdmin, (_req, res) => {
  const settings = current();
  res.json({
    methods: settings.authMethods,
    effective: effectiveAuthMethods(),
    discordReady: discordActive(),
  });
});

/**
 * Updates the sign-in method toggles.
 *
 * Guard rails, not preferences: the last usable method can never be switched
 * off, and local cannot be dropped while Discord has nothing behind it, so no
 * combination of toggles can lock every admin out.
 */
adminRouter.put('/auth-methods', requireAdmin, async (req, res, next) => {
  try {
    const desired = {
      local: req.body?.methods?.local !== false,
      discord: Boolean(req.body?.methods?.discord),
    };

    if (!desired.local && !discordActive()) {
      return res.status(409).json({
        error:
          'Local sign-in cannot be disabled while the Discord plugin is not connected: nobody could sign in.',
      });
    }
    if (!desired.local && !desired.discord) {
      return res.status(409).json({ error: 'At least one sign-in method must stay enabled.' });
    }

    await saveAuthMethods(desired);
    await audit(req.user.id, 'auth_methods.update', 'settings', 'app_settings', {
      methods: desired,
    });
    return res.json({ ok: true, effective: effectiveAuthMethods() });
  } catch (error) {
    return next(error);
  }
});

// ---------------------------------------------------------------------------
// Admins
// ---------------------------------------------------------------------------

/**
 * Lists everyone who can reach the admin panel.
 *
 * Admins arrive three ways and only one of them is revocable here, so each
 * entry declares its source rather than implying they are all the same.
 */
adminRouter.get('/admins', async (req, res, next) => {
  try {
    // A plain admin never learns who the super admins are.
    const visibleTiers = req.user.isSuperAdmin
      ? [TIERS.ADMIN, TIERS.SUPER]
      : [TIERS.ADMIN];

    const { rows } = await query(
      `SELECT id, discord_id, username, display_name, avatar, last_login_at,
              tier, permissions, totp_required, totp_confirmed_at,
              password_hash IS NOT NULL AS local
         FROM users
        WHERE tier = ANY($1::admin_tier[])
        ORDER BY tier DESC, username`,
      [visibleTiers],
    );

    const settings = current();
    let roles = [];
    let channels = [];
    let bootstrapIds = [];

    // Only super admins see how access is configured; to a plain admin the
    // deployment's shape is not their concern. The Discord-derived sources
    // exist only while that plugin is connected.
    if (req.user.isSuperAdmin && discordActive()) {
      const directory = await adminDirectory();
      roles = directory.roles;
      channels = directory.channels;
      bootstrapIds = directory.bootstrapIds;
    }

    res.json({
      canManage: req.user.isSuperAdmin,
      plugins: {
        discord: discordActive(),
        twofactor: isPluginEnabled(settings.plugins, PLUGINS.TWOFACTOR),
      },
      granted: rows.map((row) => ({
        id: row.id,
        discordId: row.discord_id,
        username: row.username,
        displayName: row.display_name,
        lastLoginAt: row.last_login_at,
        tier: row.tier,
        local: row.local,
        totpRequired: row.totp_required,
        totpEnrolled: Boolean(row.totp_confirmed_at),
        permissions: row.tier === TIERS.SUPER ? ALL_PERMISSIONS : row.permissions,
        isSelf: row.id === req.user.id,
      })),
      catalogue: ALL_PERMISSIONS.map((key) => ({ key, ...PERMISSION_LABELS[key] })),
      // Not revocable from here: these come from configuration, not a grant.
      bootstrapIds,
      adminRoles: roles,
      adminChannels: channels,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * Creates a local admin account.
 *
 * The one-time password comes back exactly once, for the granting admin to
 * hand over; the holder changes it themselves. Granting by Discord id lives on
 * the discord plugin's routes.
 */
adminRouter.post('/admins', requireAdmin, async (req, res, next) => {
  try {
    const username = String(req.body?.username ?? '').trim();
    if (!USERNAME_PATTERN.test(username)) {
      return res.status(400).json({
        error: 'Usernames are 3-32 characters: letters, numbers, dots, dashes, underscores.',
      });
    }

    // A super admin holds everything; a plain admin holds only what was
    // ticked. Granting nothing is refused, so the list never shows someone who
    // cannot actually do anything.
    const superAdmin = req.body?.superAdmin === true;
    const permissions = superAdmin ? [] : sanitisePermissions(req.body?.permissions);
    if (!superAdmin && permissions.length === 0) {
      return res.status(400).json({ error: 'Choose at least one permission.' });
    }

    const { rows: existing } = await query(
      'SELECT 1 FROM users WHERE lower(username) = lower($1) AND password_hash IS NOT NULL',
      [username],
    );
    if (existing.length > 0) {
      return res.status(409).json({ error: 'That username is already taken.' });
    }

    const password = generatePassword();
    const { rows } = await query(
      `INSERT INTO users (username, password_hash, tier, permissions)
       VALUES ($1, $2, $3, $4) RETURNING id, username`,
      [username, await hashPassword(password), superAdmin ? TIERS.SUPER : TIERS.ADMIN, permissions],
    );

    await audit(req.user.id, 'admin.grant', 'user', rows[0].id, {
      username,
      superAdmin,
      permissions,
      method: 'local',
    });
    return res.status(201).json({ ok: true, username: rows[0].username, password });
  } catch (error) {
    return next(error);
  }
});

/**
 * Resets a local admin's password to a fresh one-time value.
 *
 * The only recovery for a forgotten password; shown once, like at creation.
 */
adminRouter.post('/admins/:userId/password', requireAdmin, async (req, res, next) => {
  try {
    const password = generatePassword();
    const { rows } = await query(
      `UPDATE users SET password_hash = $2
        WHERE id = $1 AND password_hash IS NOT NULL AND tier <> 'none'
        RETURNING id, username`,
      [req.params.userId, await hashPassword(password)],
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: 'That local admin was not found.' });
    }

    await audit(req.user.id, 'admin.password_reset', 'user', req.params.userId, {});
    return res.json({ ok: true, username: rows[0].username, password });
  } catch (error) {
    return next(error);
  }
});

/**
 * Revokes a granted admin.
 *
 * Refuses to remove the caller, or to empty the admin list, so the panel
 * cannot be locked shut from inside it.
 */
adminRouter.delete('/admins/:userId', requireAdmin, async (req, res, next) => {
  try {
    if (req.params.userId === req.user.id) {
      return res.status(409).json({
        error: 'You cannot remove your own admin access. Ask another admin to do it.',
      });
    }

    // Only super admins keep the deployment reachable, so the count that
    // matters is of them - a panel full of plain admins can still be locked
    // out of setup and admin management.
    const { rows: counts } = await query(
      `SELECT count(*)::int AS n FROM users WHERE tier = 'super_admin'`,
    );
    const hasOtherSource = discordActive() && hasBootstrapSupers();

    const { rows: target } = await query('SELECT tier FROM users WHERE id = $1', [
      req.params.userId,
    ]);
    if (target.length === 0) return res.status(404).json({ error: 'That admin was not found.' });

    if (target[0].tier === TIERS.SUPER && counts[0].n <= 1 && !hasOtherSource) {
      return res.status(409).json({
        error: 'This is the only super administrator. Add another one first.',
      });
    }

    const { rowCount } = await query(
      `UPDATE users SET tier = 'none', permissions = '{}'
        WHERE id = $1 AND tier <> 'none'`,
      [req.params.userId],
    );
    if (rowCount === 0) return res.status(404).json({ error: 'That admin was not found.' });

    await audit(req.user.id, 'admin.revoke', 'user', req.params.userId, {});
    return res.json({ ok: true });
  } catch (error) {
    return next(error);
  }
});

/**
 * Changes what an existing admin may do.
 *
 * Demoting yourself is refused for the same reason revoking yourself is: it is
 * the quickest way to lock the panel and there is no way back from inside it.
 */
adminRouter.patch('/admins/:userId', requireAdmin, async (req, res, next) => {
  try {
    if (req.params.userId === req.user.id) {
      return res
        .status(409)
        .json({ error: 'You cannot change your own permissions. Ask another admin.' });
    }

    const superAdmin = req.body?.superAdmin === true;
    const permissions = superAdmin ? [] : sanitisePermissions(req.body?.permissions);
    if (!superAdmin && permissions.length === 0) {
      return res.status(400).json({ error: 'Choose at least one permission.' });
    }

    // Demoting the last super admin leaves nobody able to run setup or manage
    // admins, which is the same lockout as revoking them outright.
    if (!superAdmin) {
      const { rows: counts } = await query(
        `SELECT count(*)::int AS n FROM users WHERE tier = 'super_admin'`,
      );
      const { rows: target } = await query('SELECT tier FROM users WHERE id = $1', [
        req.params.userId,
      ]);
      if (
        target[0]?.tier === TIERS.SUPER &&
        counts[0].n <= 1 &&
        !(discordActive() && hasBootstrapSupers())
      ) {
        return res.status(409).json({
          error: 'This is the only super administrator. Promote another one first.',
        });
      }
    }

    const { rowCount } = await query(
      `UPDATE users SET tier = $2, permissions = $3 WHERE id = $1 AND tier <> 'none'`,
      [req.params.userId, superAdmin ? TIERS.SUPER : TIERS.ADMIN, permissions],
    );
    if (rowCount === 0) return res.status(404).json({ error: 'That admin was not found.' });

    await audit(req.user.id, 'admin.permissions', 'user', req.params.userId, {
      superAdmin,
      permissions,
    });
    return res.json({ ok: true });
  } catch (error) {
    return next(error);
  }
});

// ---------------------------------------------------------------------------
// Surveys
// ---------------------------------------------------------------------------

/** Lists every survey with headline response counts. */
adminRouter.get('/surveys', async (_req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT s.id, s.slug, s.title, s.status, s.created_at, s.closes_at,
              s.opens_at,
              s.collect_timing, s.collect_location, s.collect_identity,
              s.allow_response_edits, s.gate_role_ids, s.gate_channel_ids,
              -- Both joins fan out, so every count here must be DISTINCT or the
              -- two tables multiply each other's rows.
              count(DISTINCT q.id)                                       AS question_count,
              count(DISTINCT r.id)                                       AS started,
              count(DISTINCT r.id) FILTER (WHERE r.status = 'completed') AS completed
         FROM surveys s
         LEFT JOIN questions q ON q.survey_id = s.id
         LEFT JOIN responses r ON r.survey_id = s.id
        GROUP BY s.id
        ORDER BY s.created_at DESC`,
    );

    res.json({
      surveys: rows.map((row) => ({
        id: row.id,
        slug: row.slug,
        title: row.title,
        status: row.status,
        createdAt: row.created_at,
        opensAt: row.opens_at,
        closesAt: row.closes_at,
        state: liveState(row),
        gated: row.gate_role_ids.length > 0 || row.gate_channel_ids.length > 0,
        questionCount: Number(row.question_count),
        started: Number(row.started),
        completed: Number(row.completed),
        collect: {
          timing: row.collect_timing,
          location: row.collect_location,
          identity: row.collect_identity,
        },
        allowsEdits: row.allow_response_edits,
      })),
    });
  } catch (error) {
    next(error);
  }
});

/** Creates a draft survey. */
adminRouter.post('/surveys', writeSurveys, async (req, res, next) => {
  try {
    const title = String(req.body?.title ?? '').trim();
    if (!title) return res.status(400).json({ error: 'A title is required.' });

    const { rows } = await query(
      `INSERT INTO surveys (slug, title, description, created_by)
       VALUES ($1, $2, $3, $4) RETURNING id, slug`,
      [slugify(title), title, String(req.body?.description ?? ''), req.user.id],
    );

    await audit(req.user.id, 'survey.create', 'survey', rows[0].id, { title });
    return res.status(201).json({ survey: rows[0] });
  } catch (error) {
    return next(error);
  }
});

/** Returns a survey with its full question set. */
adminRouter.get('/surveys/:id', writeSurveys, async (req, res, next) => {
  try {
    const { rows } = await query('SELECT * FROM surveys WHERE id = $1', [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ error: 'Survey not found.' });

    const survey = rows[0];
    const { rows: questions } = await query(
      'SELECT * FROM questions WHERE survey_id = $1 ORDER BY position',
      [survey.id],
    );
    const { rows: options } = await query(
      `SELECT o.* FROM question_options o JOIN questions q ON q.id = o.question_id
        WHERE q.survey_id = $1 ORDER BY o.position`,
      [survey.id],
    );

    const { rows: counts } = await query(
      `SELECT count(*)::int AS started,
              count(*) FILTER (WHERE status = 'completed')::int AS completed,
              count(*) FILTER (WHERE user_id IS NOT NULL)::int AS identified
         FROM responses WHERE survey_id = $1`,
      [survey.id],
    );

    const optionsByQuestion = new Map();
    for (const option of options) {
      if (!optionsByQuestion.has(option.question_id)) optionsByQuestion.set(option.question_id, []);
      optionsByQuestion.get(option.question_id).push({ id: option.id, label: option.label });
    }

    return res.json({
      responses: counts[0],
      survey: {
        id: survey.id,
        slug: survey.slug,
        title: survey.title,
        description: survey.description,
        status: survey.status,
        opensAt: survey.opens_at,
        closesAt: survey.closes_at,
        allowResponseEdits: survey.allow_response_edits,
        collectTiming: survey.collect_timing,
        collectLocation: survey.collect_location,
        collectIdentity: survey.collect_identity,
        gateRoleIds: survey.gate_role_ids,
        gateChannelIds: survey.gate_channel_ids,
        pluginConfig: survey.plugin_config ?? {},
      },
      plugins: current().plugins ?? {},
      questions: questions.map((q) => ({
        id: q.id,
        position: q.position,
        type: q.type,
        prompt: q.prompt,
        helpText: q.help_text,
        required: q.required,
        config: q.config,
        options: optionsByQuestion.get(q.id) ?? [],
      })),
    });
  } catch (error) {
    return next(error);
  }
});

/**
 * Validates a survey's plugin configuration before it is stored.
 *
 * @param {*} config The submitted pluginConfig object.
 * @returns {string|null} An error message, or null when the shape is acceptable.
 */
function validatePluginConfig(config) {
  if (config === null || config === undefined) return null;
  if (typeof config !== 'object' || Array.isArray(config)) return 'Invalid plugin configuration.';

  if (config.announceChannelId !== undefined && config.announceChannelId !== null) {
    if (!/^\d{17,20}$/.test(String(config.announceChannelId))) {
      return 'Announcement channel is not a valid Discord channel id.';
    }
  }

  if (config.remindHoursBeforeClose !== undefined && config.remindHoursBeforeClose !== null) {
    const hours = Number(config.remindHoursBeforeClose);
    if (!Number.isFinite(hours) || hours <= 0 || hours > 8760) {
      return 'Reminder hours must be a positive number.';
    }
  }

  if (config.quota?.maxResponses !== undefined && config.quota?.maxResponses !== null) {
    const max = Number(config.quota.maxResponses);
    if (!Number.isInteger(max) || max < 1) {
      return 'Response quota must be a whole number of at least 1.';
    }
  }

  return null;
}

/** Columns a PATCH may set, mapped from their request body names. */
const EDITABLE = {
  title: 'title',
  description: 'description',
  opensAt: 'opens_at',
  closesAt: 'closes_at',
  allowResponseEdits: 'allow_response_edits',
  collectTiming: 'collect_timing',
  collectLocation: 'collect_location',
  collectIdentity: 'collect_identity',
  gateRoleIds: 'gate_role_ids',
  gateChannelIds: 'gate_channel_ids',
  pluginConfig: 'plugin_config',
};

/**
 * Updates survey settings.
 *
 * Turning `collectIdentity` off also erases the identities already recorded,
 * so the toggle means the same thing retroactively as it does going forward.
 */
adminRouter.patch('/surveys/:id', writeSurveys, async (req, res, next) => {
  try {
    // Plugin config is stored as JSONB and later fed to the reminder sweep and
    // the Discord API, so its shape is validated here rather than trusted. A
    // bad value would otherwise break the reminder job for every open survey.
    if ('pluginConfig' in req.body) {
      const problem = validatePluginConfig(req.body.pluginConfig);
      if (problem) return res.status(400).json({ error: problem });
    }

    const sets = [];
    const values = [req.params.id];

    for (const [field, column] of Object.entries(EDITABLE)) {
      if (!(field in req.body)) continue;
      values.push(req.body[field]);
      sets.push(`${column} = $${values.length}`);
    }
    if (sets.length === 0) return res.status(400).json({ error: 'Nothing to update.' });

    const { rows } = await query(
      `UPDATE surveys SET ${sets.join(', ')}, updated_at = now()
        WHERE id = $1 RETURNING id, collect_identity`,
      values,
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Survey not found.' });

    if (req.body.collectIdentity === false) {
      await query('UPDATE responses SET user_id = NULL WHERE survey_id = $1', [req.params.id]);
    }

    await audit(req.user.id, 'survey.update', 'survey', req.params.id, {
      fields: Object.keys(req.body),
    });
    return res.json({ ok: true });
  } catch (error) {
    return next(error);
  }
});

/** Opens or closes a survey. */
adminRouter.post('/surveys/:id/status', publishSurveys, async (req, res, next) => {
  try {
    const status = req.body?.status;
    if (!['draft', 'open', 'closed'].includes(status)) {
      return res.status(400).json({ error: 'Status must be draft, open, or closed.' });
    }

    const { rows: existing } = await query(
      'SELECT opens_at, closes_at FROM surveys WHERE id = $1',
      [req.params.id],
    );
    if (existing.length === 0) return res.status(404).json({ error: 'Survey not found.' });

    if (status === 'open') {
      const { rows } = await query(
        'SELECT count(*)::int AS n FROM questions WHERE survey_id = $1',
        [req.params.id],
      );
      if (rows[0].n === 0) {
        return res.status(400).json({ error: 'Add at least one question before opening.' });
      }
    }

    // Acting by hand against a future schedule silently rewrites it, so the
    // caller has to say that is what they meant.
    const now = Date.now();
    const override = req.body?.overrideSchedule === true;
    const pending = (value) => value && new Date(value).getTime() > now;

    if (!override && status === 'open' && pending(existing[0].opens_at)) {
      return res.status(409).json({
        error: 'This survey is scheduled to open later.',
        conflict: 'opens_at',
        scheduledFor: existing[0].opens_at,
        requiresOverride: true,
      });
    }
    if (!override && status === 'closed' && pending(existing[0].closes_at)) {
      return res.status(409).json({
        error: 'This survey is scheduled to close later.',
        conflict: 'closes_at',
        scheduledFor: existing[0].closes_at,
        requiresOverride: true,
      });
    }

    const { rows } = await query(
      // Every use of $2 is cast: without it Postgres sees the parameter as
      // survey_status in the assignment and text in the comparisons, and
      // refuses to deduce a single type.
      `UPDATE surveys
          SET status = $2::survey_status,
              opened_at = CASE WHEN $2::survey_status = 'open'
                               THEN COALESCE(opened_at, now()) ELSE opened_at END,
              closed_at = CASE WHEN $2::survey_status = 'closed'
                               THEN now() ELSE NULL END,
              -- Opening by hand supersedes a future opening time, and the same
              -- for closing, so the schedule never re-applies afterwards.
              opens_at = CASE WHEN $2::survey_status = 'open'
                                   AND opens_at IS NOT NULL AND opens_at > now()
                              THEN now() ELSE opens_at END,
              closes_at = CASE WHEN $2::survey_status = 'closed'
                                    AND closes_at IS NOT NULL AND closes_at > now()
                               THEN now() ELSE closes_at END,
              -- Reset the opposite direction's one-shot flags so reopening a
              -- survey can announce again, and the reminder can fire once more.
              announce_open_sent  = CASE WHEN $2::survey_status = 'closed' THEN false ELSE announce_open_sent END,
              announce_close_sent = CASE WHEN $2::survey_status = 'open'   THEN false ELSE announce_close_sent END,
              reminder_sent       = CASE WHEN $2::survey_status = 'open'   THEN false ELSE reminder_sent END,
              updated_at = now()
        WHERE id = $1 RETURNING id`,
      [req.params.id, status],
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Survey not found.' });

    await audit(req.user.id, `survey.${status}`, 'survey', req.params.id, { override });

    // Announce the change if the plugin is on and a channel is configured.
    // Best-effort: a Discord failure is reported as a warning, never a 500,
    // so the status change itself always succeeds.
    let announcement = null;
    if (status === 'open' || status === 'closed') {
      announcement = await maybeAnnounce(req.params.id, status).catch((error) => ({
        posted: false,
        error: error.message,
      }));
    }

    return res.json({ ok: true, announcement });
  } catch (error) {
    return next(error);
  }
});

/**
 * Rotates a survey's respondent key.
 *
 * Every existing response is detached from its author: the stored hashes can no
 * longer be reproduced from any Discord id. Recorded usernames are cleared at
 * the same time, since leaving them would defeat the point.
 */
adminRouter.post('/surveys/:id/anonymise', deleteSurveys, async (req, res, next) => {
  try {
    await transaction(async (client) => {
      await client.query(
        'UPDATE surveys SET respondent_key = gen_random_bytes(32), updated_at = now() WHERE id = $1',
        [req.params.id],
      );
      await client.query(
        `UPDATE responses SET respondent_hash = gen_random_bytes(32), user_id = NULL
          WHERE survey_id = $1`,
        [req.params.id],
      );
      await client.query('UPDATE surveys SET collect_identity = false WHERE id = $1', [
        req.params.id,
      ]);
    });

    await audit(req.user.id, 'survey.anonymise', 'survey', req.params.id, {});
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

/** Deletes a survey and everything attached to it. */
adminRouter.delete('/surveys/:id', deleteSurveys, async (req, res, next) => {
  try {
    const { rowCount } = await query('DELETE FROM surveys WHERE id = $1', [req.params.id]);
    if (rowCount === 0) return res.status(404).json({ error: 'Survey not found.' });

    // The row cascade removes answer_files records; the bytes on disk need
    // removing separately. Best-effort, after the database change is committed.
    await deleteSurveyFiles(req.params.id).catch((error) =>
      console.warn(`Failed to remove uploaded files for survey ${req.params.id}: ${error.message}`),
    );

    await audit(req.user.id, 'survey.delete', 'survey', req.params.id, {});
    return res.json({ ok: true });
  } catch (error) {
    return next(error);
  }
});

// ---------------------------------------------------------------------------
// Questions
// ---------------------------------------------------------------------------

/**
 * Validates one incoming question definition.
 *
 * @param {object} question Question payload from the client.
 * @returns {string|null} An error message, or null when the question is valid.
 */
function validateQuestion(question) {
  if (!QUESTION_TYPES.has(question.type)) return `Unknown question type: ${question.type}`;
  if (!String(question.prompt ?? '').trim()) return 'Every question needs a prompt.';

  if (CHOICE_TYPES.has(question.type)) {
    const options = question.options ?? [];
    if (options.length < 2) return 'Choice questions need at least two options.';
    if (options.some((option) => !String(option.label ?? '').trim())) {
      return 'Every option needs a label.';
    }
  }

  const { min, max } = question.config ?? {};
  if (min !== undefined && max !== undefined && Number(min) > Number(max)) {
    return 'Minimum cannot exceed maximum.';
  }

  if (question.type === 'file_upload') {
    const mb = Number(question.config?.maxSizeMb);
    if (!Number.isFinite(mb) || mb < 1 || mb > 25) {
      return 'File size limit must be between 1 and 25 MB.';
    }
    if (!Array.isArray(question.config?.acceptedFormats) || question.config.acceptedFormats.length === 0) {
      return 'List at least one accepted file format.';
    }
  }
  return null;
}

/**
 * Replaces a survey's question set.
 *
 * Questions carrying an existing id are updated in place so their answers
 * survive; questions dropped from the payload are deleted, which cascades to
 * their answers. That deletion is refused when answers exist unless the caller
 * passes `?force=1`.
 */
adminRouter.put('/surveys/:id/questions', writeSurveys, async (req, res, next) => {
  try {
    const incoming = Array.isArray(req.body?.questions) ? req.body.questions : null;
    if (!incoming) return res.status(400).json({ error: 'Expected a list of questions.' });

    for (const question of incoming) {
      const problem = validateQuestion(question);
      if (problem) return res.status(400).json({ error: problem });
    }

    const { rows: existing } = await query(
      'SELECT id FROM questions WHERE survey_id = $1',
      [req.params.id],
    );
    const keptIds = new Set(incoming.map((q) => q.id).filter(Boolean));
    const removedIds = existing.map((q) => q.id).filter((id) => !keptIds.has(id));

    if (removedIds.length > 0 && req.query.force !== '1') {
      const { rows } = await query(
        'SELECT count(*)::int AS n FROM answers WHERE question_id = ANY($1)',
        [removedIds],
      );
      if (rows[0].n > 0) {
        return res.status(409).json({
          error: 'Deleting these questions would discard existing answers.',
          answersAffected: rows[0].n,
          requiresForce: true,
        });
      }
    }

    await transaction(async (client) => {
      if (removedIds.length > 0) {
        await client.query('DELETE FROM questions WHERE id = ANY($1)', [removedIds]);
      }

      for (const [index, question] of incoming.entries()) {
        const fields = [
          index,
          question.type,
          String(question.prompt).trim(),
          String(question.helpText ?? ''),
          question.required !== false,
          question.config ?? {},
        ];

        let questionId = question.id;
        if (questionId) {
          await client.query(
            `UPDATE questions
                SET position = $2, type = $3, prompt = $4, help_text = $5,
                    required = $6, config = $7, updated_at = now()
              WHERE id = $1 AND survey_id = $8`,
            [questionId, ...fields, req.params.id],
          );
        } else {
          const { rows } = await client.query(
            `INSERT INTO questions (survey_id, position, type, prompt, help_text, required, config)
             VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
            [req.params.id, ...fields],
          );
          questionId = rows[0].id;
        }

        if (!CHOICE_TYPES.has(question.type)) {
          await client.query('DELETE FROM question_options WHERE question_id = $1', [questionId]);
          continue;
        }

        const options = question.options ?? [];
        const keptOptionIds = options.map((o) => o.id).filter(Boolean);
        await client.query(
          `DELETE FROM question_options
            WHERE question_id = $1 AND NOT (id = ANY($2::uuid[]))`,
          [questionId, keptOptionIds],
        );

        for (const [optionIndex, option] of options.entries()) {
          if (option.id) {
            await client.query(
              'UPDATE question_options SET position = $2, label = $3 WHERE id = $1',
              [option.id, optionIndex, String(option.label).trim()],
            );
          } else {
            await client.query(
              'INSERT INTO question_options (question_id, position, label) VALUES ($1, $2, $3)',
              [questionId, optionIndex, String(option.label).trim()],
            );
          }
        }
      }
    });

    await audit(req.user.id, 'survey.questions', 'survey', req.params.id, {
      count: incoming.length,
      removed: removedIds.length,
    });
    return res.json({ ok: true });
  } catch (error) {
    return next(error);
  }
});

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

/**
 * Loads a survey together with its questions, options and completed answers.
 *
 * @param {string} surveyId
 * @returns {Promise<object|null>} Everything needed to aggregate or export.
 */
async function loadForReporting(surveyId) {
  const { rows } = await query('SELECT * FROM surveys WHERE id = $1', [surveyId]);
  if (rows.length === 0) return null;

  const [questions, options, responses, answers] = await Promise.all([
    query('SELECT * FROM questions WHERE survey_id = $1 ORDER BY position', [surveyId]),
    query(
      `SELECT o.* FROM question_options o JOIN questions q ON q.id = o.question_id
        WHERE q.survey_id = $1 ORDER BY o.position`,
      [surveyId],
    ),
    query(
      `SELECT r.id, r.status, r.started_at, r.completed_at, r.duration_ms, r.country_code,
              u.username, u.display_name
         FROM responses r LEFT JOIN users u ON u.id = r.user_id
        WHERE r.survey_id = $1 ORDER BY r.started_at`,
      [surveyId],
    ),
    query(
      `SELECT a.response_id, a.question_id, a.value, a.time_ms
         FROM answers a JOIN responses r ON r.id = a.response_id
        WHERE r.survey_id = $1 AND r.status = 'completed'`,
      [surveyId],
    ),
  ]);

  return {
    survey: rows[0],
    questions: questions.rows,
    options: options.rows,
    responses: responses.rows,
    answers: answers.rows,
  };
}

/** Returns chart-ready aggregates and headline metrics for a survey. */
adminRouter.get('/surveys/:id/results', readResults, async (req, res, next) => {
  try {
    const data = await loadForReporting(req.params.id);
    if (!data) return res.status(404).json({ error: 'Survey not found.' });

    const { survey, questions, options, responses, answers } = data;

    const optionsByQuestion = new Map();
    for (const option of options) {
      if (!optionsByQuestion.has(option.question_id)) optionsByQuestion.set(option.question_id, []);
      optionsByQuestion.get(option.question_id).push({ id: option.id, label: option.label });
    }

    const answersByQuestion = new Map();
    for (const answer of answers) {
      if (!answersByQuestion.has(answer.question_id)) answersByQuestion.set(answer.question_id, []);
      answersByQuestion.get(answer.question_id).push(answer);
    }

    const completed = responses.filter((r) => r.status === 'completed');
    const durations = completed.map((r) => r.duration_ms).filter((ms) => typeof ms === 'number');

    const perQuestion = questions.map((question) => {
      const questionAnswers = answersByQuestion.get(question.id) ?? [];
      const questionOptions = optionsByQuestion.get(question.id) ?? [];

      const times = questionAnswers.map((a) => a.time_ms).filter((ms) => typeof ms === 'number');

      // An optional question is worth judging on take-up, so the share of
      // completed responses that actually answered it is reported. Measured
      // against everyone who finished the survey, not just those who reached
      // this question, since a skip and a non-answer are the same outcome.
      const finished = completed.length;
      const engaged = questionAnswers.filter((a) => !a.value?.skipped).length;

      const base = {
        id: question.id,
        type: question.type,
        prompt: question.prompt,
        required: question.required,
        responses: questionAnswers.length,
        participation: finished > 0 ? engaged / finished : null,
        participated: engaged,
        outOf: finished,
        medianTimeMs: null,
      };

      if (survey.collect_timing && times.length > 0) {
        const sorted = [...times].sort((a, b) => a - b);
        const mid = Math.floor(sorted.length / 2);
        base.medianTimeMs =
          sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
      }

      if (question.type === 'ranking') {
        return { ...base, ...aggregateRanking(questionOptions, questionAnswers) };
      }

      const categorised = categorise(question, questionOptions, questionAnswers);

      // Free text is never charted. Dozens of one-off answers make a
      // meaningless chart and a very wide page, so only counts are returned
      // and the answers themselves are fetched on demand.
      if (question.type === 'short_text' || question.type === 'long_text') {
        return {
          ...base,
          kind: 'text',
          categories: [],
          answered: categorised.answered,
          skipped: categorised.skipped,
          distinct: categorised.categories.length,
        };
      }

      // Files are listed and downloaded on request, never charted.
      if (question.type === 'file_upload') {
        const uploaded = questionAnswers.filter((a) => !a.value?.skipped && a.value?.fileId).length;
        return {
          ...base,
          kind: 'file',
          categories: [],
          answered: uploaded,
          skipped: categorised.skipped,
        };
      }

      if (question.type === 'integer' || question.type === 'scale') {
        return {
          ...base,
          ...categorised,
          // A scale is ordinal: 1,2,3,4,5 reads correctly, "whichever was
          // picked most" does not. Order by value rather than by frequency.
          categories: [...categorised.categories].sort((a, b) => Number(a.key) - Number(b.key)),
          stats: numericStats(questionAnswers),
        };
      }

      // Choice questions keep their preset options as slices, with every
      // custom answer collapsed into a single neutral bucket. The individual
      // wordings are read separately, on request.
      const preset = categorised.categories.filter((c) => !c.custom);
      const custom = categorised.categories.filter((c) => c.custom);
      const customTotal = custom.reduce((sum, c) => sum + c.count, 0);

      return {
        ...base,
        ...categorised,
        categories:
          customTotal > 0
            ? [
                ...preset,
                {
                  key: '__custom__',
                  label: `Custom answers (${custom.length})`,
                  count: customTotal,
                  custom: true,
                  folded: true,
                },
              ]
            : preset,
        customCount: customTotal,
        customDistinct: custom.length,
      };
    });

    const byCountry = new Map();
    if (survey.collect_location) {
      for (const response of completed) {
        const code = response.country_code ?? 'Unknown';
        byCountry.set(code, (byCountry.get(code) ?? 0) + 1);
      }
    }

    return res.json({
      survey: {
        id: survey.id,
        title: survey.title,
        status: survey.status,
        collect: {
          timing: survey.collect_timing,
          location: survey.collect_location,
          identity: survey.collect_identity,
        },
      },
      plugins: current().plugins ?? {},
      metrics: {
        started: responses.length,
        completed: completed.length,
        abandoned: responses.length - completed.length,
        completionRate: responses.length ? completed.length / responses.length : 0,
        totalTimeMs: durations.reduce((sum, ms) => sum + ms, 0),
        medianTimeMs: durations.length
          ? [...durations].sort((a, b) => a - b)[Math.floor(durations.length / 2)]
          : null,
      },
      countries: [...byCountry.entries()]
        .map(([code, count]) => ({ code, count }))
        .sort((a, b) => b.count - a.count),
      questions: perQuestion,
    });
  } catch (error) {
    return next(error);
  }
});

/**
 * Lists the written answers to one question.
 *
 * Kept off the results payload deliberately: free text can be long and
 * numerous, and it is only wanted when somebody asks to read it. Identical
 * answers are grouped so repetition is visible without scrolling.
 */
adminRouter.get('/surveys/:id/questions/:questionId/texts', readResults, async (req, res, next) => {
  try {
    const { rows: questions } = await query(
      'SELECT * FROM questions WHERE id = $1 AND survey_id = $2',
      [req.params.questionId, req.params.id],
    );
    if (questions.length === 0) return res.status(404).json({ error: 'Question not found.' });

    const question = questions[0];
    const { rows: answers } = await query(
      `SELECT a.value, r.completed_at, u.username, u.display_name
         FROM answers a
         JOIN responses r ON r.id = a.response_id
         LEFT JOIN users u ON u.id = r.user_id
        WHERE a.question_id = $1 AND r.status = 'completed'
        ORDER BY r.completed_at`,
      [question.id],
    );

    const { rows: surveys } = await query(
      'SELECT collect_identity FROM surveys WHERE id = $1',
      [req.params.id],
    );
    const identified = surveys[0]?.collect_identity === true;

    // Grouped case-insensitively, matching how the charts count categories.
    const groups = new Map();
    for (const row of answers) {
      const value = row.value ?? {};
      const text =
        question.type === 'short_text' || question.type === 'long_text' ? value.text : value.other;
      if (!text) continue;

      const key = text.toLowerCase();
      const existing = groups.get(key);
      if (existing) {
        existing.count += 1;
        if (identified && row.username) existing.authors.push(row.display_name || row.username);
      } else {
        groups.set(key, {
          text,
          count: 1,
          authors: identified && row.username ? [row.display_name || row.username] : [],
        });
      }
    }

    return res.json({
      prompt: question.prompt,
      type: question.type,
      identified,
      total: [...groups.values()].reduce((sum, g) => sum + g.count, 0),
      distinct: groups.size,
      answers: [...groups.values()].sort((a, b) => b.count - a.count),
    });
  } catch (error) {
    return next(error);
  }
});

/**
 * Lists the files uploaded to one file-upload question.
 *
 * Only completed responses are included, matching the charts. Usernames appear
 * only when the survey records identity.
 */
adminRouter.get('/surveys/:id/questions/:questionId/files', readResults, async (req, res, next) => {
  try {
    const { rows: surveys } = await query(
      'SELECT collect_identity FROM surveys WHERE id = $1',
      [req.params.id],
    );
    if (surveys.length === 0) return res.status(404).json({ error: 'Survey not found.' });
    const identified = surveys[0].collect_identity === true;

    const { rows } = await query(
      `SELECT f.id, f.original_name, f.mime, f.size_bytes, f.created_at,
              u.username, u.display_name
         FROM answer_files f
         JOIN responses r ON r.id = f.response_id
         LEFT JOIN users u ON u.id = r.user_id
        WHERE f.question_id = $1 AND r.survey_id = $2 AND r.status = 'completed'
        ORDER BY f.created_at`,
      [req.params.questionId, req.params.id],
    );

    return res.json({
      identified,
      files: rows.map((row) => ({
        id: row.id,
        name: row.original_name,
        mime: row.mime,
        sizeBytes: row.size_bytes,
        author: identified ? row.display_name || row.username || null : null,
      })),
    });
  } catch (error) {
    return next(error);
  }
});

/**
 * Streams one uploaded file for download.
 *
 * The stored filename is never trusted for the path - the file is located by
 * its database id and its original name is only used for the download header.
 */
adminRouter.get('/surveys/:id/files/:fileId', readResults, async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT f.storage_key, f.original_name, f.mime, f.size_bytes
         FROM answer_files f
         JOIN responses r ON r.id = f.response_id
        WHERE f.id = $1 AND r.survey_id = $2`,
      [req.params.fileId, req.params.id],
    );
    if (rows.length === 0) return res.status(404).json({ error: 'File not found.' });

    const file = rows[0];
    // Force a download rather than inline rendering, so an uploaded HTML file
    // cannot execute in the admin's session.
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Length', file.size_bytes);
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${file.original_name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '')}"`,
    );
    return res.sendFile(pathForKey(file.storage_key), (error) => {
      if (error && !res.headersSent) next(error);
    });
  } catch (error) {
    return next(error);
  }
});

/**
 * Draws a random completed respondent as a raffle winner.
 *
 * Reveals only what the survey already recorded: a username when identity was
 * collected, otherwise just an anonymous response number. Requires the raffle
 * plugin to be enabled.
 */
adminRouter.post('/surveys/:id/raffle', readResults, async (req, res, next) => {
  try {
    if (!isPluginEnabled(current().plugins, PLUGINS.RAFFLE)) {
      return res.status(409).json({ error: 'The Raffle Picker plugin is not enabled.' });
    }

    const { rows: surveys } = await query(
      'SELECT collect_identity FROM surveys WHERE id = $1',
      [req.params.id],
    );
    if (surveys.length === 0) return res.status(404).json({ error: 'Survey not found.' });

    // ORDER BY random() picks uniformly among completed responses in one query.
    const { rows } = await query(
      `SELECT r.id, u.username, u.display_name,
              row_number() OVER (ORDER BY r.completed_at) AS ordinal
         FROM responses r LEFT JOIN users u ON u.id = r.user_id
        WHERE r.survey_id = $1 AND r.status = 'completed'
        ORDER BY random() LIMIT 1`,
      [req.params.id],
    );
    if (rows.length === 0) {
      return res.status(409).json({ error: 'No completed responses to draw from yet.' });
    }

    const winner = rows[0];
    await audit(req.user.id, 'survey.raffle', 'survey', req.params.id, {});

    return res.json({
      winner: surveys[0].collect_identity
        ? { identified: true, name: winner.display_name || winner.username || 'Unknown member' }
        : { identified: false, response: Number(winner.ordinal) },
    });
  } catch (error) {
    return next(error);
  }
});

/**
 * Exports completed responses as CSV or JSON.
 *
 * Identity columns appear only when the survey recorded them, so an export can
 * never reveal more than the survey disclosed to its participants.
 */
adminRouter.get('/surveys/:id/export', readResults, async (req, res, next) => {
  try {
    const data = await loadForReporting(req.params.id);
    if (!data) return res.status(404).json({ error: 'Survey not found.' });

    const { survey, questions, options, responses, answers } = data;
    const format = req.query.format === 'json' ? 'json' : 'csv';

    const optionLabels = new Map(options.map((option) => [option.id, option.label]));
    const answersByResponse = new Map();
    for (const answer of answers) {
      if (!answersByResponse.has(answer.response_id)) {
        answersByResponse.set(answer.response_id, new Map());
      }
      answersByResponse.get(answer.response_id).set(answer.question_id, answer);
    }

    const completed = responses.filter((r) => r.status === 'completed');

    const rows = completed.map((response, index) => {
      const byQuestion = answersByResponse.get(response.id) ?? new Map();
      const record = { response: index + 1, submittedAt: response.completed_at };

      if (survey.collect_identity) {
        record.username = response.username ?? '';
        record.displayName = response.display_name ?? '';
      }
      if (survey.collect_location) record.country = response.country_code ?? '';
      if (survey.collect_timing) record.durationMs = response.duration_ms ?? '';

      record.answers = questions.map((question) => {
        const answer = byQuestion.get(question.id);
        return {
          questionId: question.id,
          prompt: question.prompt,
          value: formatAnswer(question, optionLabels, answer?.value),
          timeMs: survey.collect_timing ? answer?.time_ms ?? null : undefined,
        };
      });

      return record;
    });

    const filename = `${survey.slug}-responses`;

    if (format === 'json') {
      res.setHeader('Content-Disposition', `attachment; filename="${filename}.json"`);
      return res.json({
        survey: { id: survey.id, slug: survey.slug, title: survey.title },
        exportedAt: new Date().toISOString(),
        collected: {
          timing: survey.collect_timing,
          location: survey.collect_location,
          identity: survey.collect_identity,
        },
        responses: rows,
      });
    }

    const headers = ['Response', 'Submitted at'];
    if (survey.collect_identity) headers.push('Username', 'Display name');
    if (survey.collect_location) headers.push('Country');
    if (survey.collect_timing) headers.push('Total time (s)');
    for (const question of questions) {
      headers.push(question.prompt);
      if (survey.collect_timing) headers.push(`${question.prompt} (s)`);
    }

    const csvRows = rows.map((record) => {
      const row = [record.response, record.submittedAt];
      if (survey.collect_identity) row.push(record.username, record.displayName);
      if (survey.collect_location) row.push(record.country);
      if (survey.collect_timing) row.push(Math.round((record.durationMs || 0) / 1000));

      for (const answer of record.answers) {
        row.push(answer.value);
        if (survey.collect_timing) row.push(answer.timeMs ? Math.round(answer.timeMs / 1000) : '');
      }
      return row;
    });

    await audit(req.user.id, 'survey.export', 'survey', survey.id, { format, rows: rows.length });

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}.csv"`);
    // A BOM keeps Excel from mangling non-ASCII answers.
    return res.send(`﻿${toCsv(headers, csvRows)}`);
  } catch (error) {
    return next(error);
  }
});
