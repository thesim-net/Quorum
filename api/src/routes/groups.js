import { Router } from 'express';
import { query } from '../db/pool.js';
import { current } from '../lib/settings.js';
import { PLUGINS, isPluginEnabled } from '../lib/plugins.js';
import {
  ALL_PERMISSIONS,
  PERMISSION_LABELS,
  TIERS,
  sanitisePermissions,
} from '../lib/permissionSet.js';
import { SUPER_ADMIN_NEEDS_NO_GROUP, mayGrantGroupAdmin } from '../lib/adminAccounts.js';
import { administeredGroups, requireGroupControl } from '../lib/groups.js';
import { requireAdmin, requireGroupAdmin } from '../middleware/session.js';
import { cachedGuildName } from '../plugins/discord/gate.js';

/**
 * Group management, mounted under /api/admin/groups.
 *
 * Shaping the deployment - creating, renaming and deleting groups, deciding
 * what a group's members may do and who may take its surveys, and granting one
 * group access to another's surveys - stays a super admin's business, the same
 * class as managing admins.
 *
 * Membership is not. An administrator of a group runs that group's membership:
 * who is in it, and which of them administer it alongside them. That authority
 * is held per group and never travels, so those routes are guarded by
 * `requireGroupControl`, which asks only about the group named in the request.
 */
export const groupsRouter = Router();

const NAME_MAX = 60;

/** Whether the discord plugin is enabled with a server connected. */
const discordActive = () =>
  isPluginEnabled(current().plugins, PLUGINS.DISCORD) && current().discord.configured;

/**
 * Filters a submitted list of Discord snowflakes.
 *
 * The lists reach the Discord API and the gate, so anything that is not an id
 * is dropped here rather than stored and puzzled over later.
 *
 * @param {*} input Whatever the client sent.
 * @returns {string[]} Valid, de-duplicated ids.
 */
const sanitiseIds = (input) =>
  Array.isArray(input)
    ? [...new Set(input.map((id) => String(id ?? '').trim()).filter((id) => /^\d{17,20}$/.test(id)))]
    : [];

/**
 * Records an admin action for the audit trail.
 *
 * @param {string} actorId User id of the acting admin.
 * @param {string} action Action name, e.g. `group.create`.
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
 * Lists the groups the caller may work with, each with its members, grants,
 * member permissions and audience, plus the admins that can be assigned.
 *
 * A super admin sees every group. An administrator of a group sees exactly the
 * groups they administer - not the ones they merely belong to - because those
 * are the only ones this page lets them change. Super admins are filtered out
 * of the member lists for anyone else, keeping the rule that they are not
 * enumerable by the people who merely help run surveys, and out of the
 * assignable list for everyone, because they cannot be members at all.
 *
 * The super admin count comes back once rather than per group: the same people
 * reach every group, so repeating the number per row would only suggest it
 * varies.
 */
groupsRouter.get('/', requireGroupAdmin, async (req, res, next) => {
  try {
    const [groups, members, grants, admins, supers, administered] = await Promise.all([
      query(
        `SELECT id, name, member_permissions, require_guild, gate_role_ids, gate_channel_ids
           FROM groups ORDER BY name`,
      ),
      query(
        `SELECT gm.group_id, gm.is_admin, u.id, u.username, u.display_name, u.tier
           FROM group_members gm JOIN users u ON u.id = gm.user_id
          ORDER BY u.tier DESC, u.username`,
      ),
      query('SELECT source_group_id, target_group_id, permissions FROM group_grants'),
      // Anyone who can reach the panel and is not a super admin can be
      // assigned. A super administrator already reaches every group, so a
      // membership would grant them nothing and imply something untrue.
      query(
        `SELECT id, username, display_name, tier FROM users
          WHERE tier <> 'none' AND tier <> 'super_admin' ORDER BY username`,
      ),
      query(`SELECT count(*)::int AS n FROM users WHERE tier = 'super_admin'`),
      req.user.isSuperAdmin ? Promise.resolve(null) : administeredGroups(req.user),
    ]);

    const visible = (groupId) => administered === null || administered.has(groupId);
    const hidden = (row) => administered !== null && row.tier === TIERS.SUPER;

    const membersByGroup = new Map();
    for (const row of members.rows) {
      if (!visible(row.group_id) || hidden(row)) continue;
      if (!membersByGroup.has(row.group_id)) membersByGroup.set(row.group_id, []);
      membersByGroup.get(row.group_id).push({
        id: row.id,
        username: row.username,
        displayName: row.display_name,
        tier: row.tier,
        administers: row.is_admin,
      });
    }

    const grantsByGroup = new Map();
    for (const row of grants.rows) {
      if (!grantsByGroup.has(row.source_group_id)) grantsByGroup.set(row.source_group_id, []);
      grantsByGroup.get(row.source_group_id).push({
        targetGroupId: row.target_group_id,
        permissions: row.permissions,
      });
    }

    res.json({
      // Shaping groups themselves stays super-admin work; the membership of
      // every group returned here is the caller's to run either way.
      canManageGroups: req.user.isSuperAdmin,
      // Shown against every group, and never folded into its member count:
      // super administrators reach each group without belonging to any.
      superAdminCount: supers.rows[0].n,
      groups: groups.rows
        .filter((group) => visible(group.id))
        .map((group) => ({
          id: group.id,
          name: group.name,
          memberPermissions: group.member_permissions,
          requireGuild: group.require_guild,
          gateRoleIds: group.gate_role_ids,
          gateChannelIds: group.gate_channel_ids,
          members: membersByGroup.get(group.id) ?? [],
          grants: grantsByGroup.get(group.id) ?? [],
        })),
      admins: admins.rows.map((row) => ({
        id: row.id,
        username: row.username,
        displayName: row.display_name,
        tier: row.tier,
      })),
      // Whether the audience section can offer the guild checkbox at all, and
      // what to call the server on its label.
      discord: {
        ready: discordActive(),
        guildName: discordActive() ? current().discord.guildName ?? cachedGuildName() : null,
      },
      catalogue: ALL_PERMISSIONS.map((key) => ({ key, ...PERMISSION_LABELS[key] })),
    });
  } catch (error) {
    next(error);
  }
});

/** Creates a group. */
groupsRouter.post('/', requireAdmin, async (req, res, next) => {
  try {
    const name = String(req.body?.name ?? '').trim();
    if (!name) return res.status(400).json({ error: 'A group name is required.' });
    if (name.length > NAME_MAX) {
      return res.status(400).json({ error: `A group name is at most ${NAME_MAX} characters.` });
    }

    const memberPermissions = sanitisePermissions(req.body?.memberPermissions);
    try {
      const { rows } = await query(
        'INSERT INTO groups (name, member_permissions) VALUES ($1, $2) RETURNING id',
        [name, memberPermissions],
      );
      await audit(req.user.id, 'group.create', 'group', rows[0].id, { name, memberPermissions });
      return res.status(201).json({ id: rows[0].id });
    } catch (error) {
      if (error.code === '23505') {
        return res.status(409).json({ error: 'A group with that name already exists.' });
      }
      throw error;
    }
  } catch (error) {
    return next(error);
  }
});

/**
 * Renames a group, sets what its members may do, or sets who may take its
 * surveys.
 *
 * The audience is the group's, not the survey's: every survey the group owns is
 * offered to whoever satisfies it. Turning the guild requirement on needs a
 * connected server, or the group would gate its surveys on something nothing
 * can answer; only the change is refused, never a save that carries the flag
 * along, or a gated group could not be edited - including to turn the flag back
 * off - once its server went away.
 */
groupsRouter.patch('/:id', requireAdmin, async (req, res, next) => {
  try {
    const { rows: existing } = await query(
      'SELECT id, require_guild FROM groups WHERE id = $1',
      [req.params.id],
    );
    if (existing.length === 0) return res.status(404).json({ error: 'Group not found.' });

    const body = req.body ?? {};

    if (body.requireGuild === true && !existing[0].require_guild && !discordActive()) {
      return res.status(409).json({
        error: 'Connect a Discord server before limiting a group to its members.',
      });
    }

    if (typeof body.name === 'string') {
      const name = body.name.trim();
      if (!name) return res.status(400).json({ error: 'A group name is required.' });
      if (name.length > NAME_MAX) {
        return res.status(400).json({ error: `A group name is at most ${NAME_MAX} characters.` });
      }
      try {
        await query('UPDATE groups SET name = $2 WHERE id = $1', [req.params.id, name]);
      } catch (error) {
        if (error.code === '23505') {
          return res.status(409).json({ error: 'A group with that name already exists.' });
        }
        throw error;
      }
    }

    if ('memberPermissions' in body) {
      await query('UPDATE groups SET member_permissions = $2 WHERE id = $1', [
        req.params.id,
        sanitisePermissions(body.memberPermissions),
      ]);
    }

    if ('requireGuild' in body) {
      await query('UPDATE groups SET require_guild = $2 WHERE id = $1', [
        req.params.id,
        body.requireGuild === true,
      ]);
    }

    if ('gateRoleIds' in body) {
      await query('UPDATE groups SET gate_role_ids = $2 WHERE id = $1', [
        req.params.id,
        sanitiseIds(body.gateRoleIds),
      ]);
    }

    if ('gateChannelIds' in body) {
      await query('UPDATE groups SET gate_channel_ids = $2 WHERE id = $1', [
        req.params.id,
        sanitiseIds(body.gateChannelIds),
      ]);
    }

    await audit(req.user.id, 'group.update', 'group', req.params.id, {
      fields: Object.keys(body),
    });
    return res.json({ ok: true });
  } catch (error) {
    return next(error);
  }
});

/**
 * Deletes a group.
 *
 * There is no default group to hand its surveys to any more, so a survey that
 * belongs to this group and nothing else has nowhere to go: it would be left
 * takeable by nobody and reachable by nobody. That blocks the delete, and the
 * refusal says how many surveys are in that position so the decision can be
 * made rather than guessed at. Surveys that also belong elsewhere simply lose
 * this one group, which the row cascade does on its own.
 */
groupsRouter.delete('/:id', requireAdmin, async (req, res, next) => {
  try {
    const { rows } = await query('SELECT id FROM groups WHERE id = $1', [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ error: 'Group not found.' });

    const { rows: stranded } = await query(
      `SELECT count(*)::int AS n
         FROM survey_groups sg
        WHERE sg.group_id = $1
          AND NOT EXISTS (
            SELECT 1 FROM survey_groups other
             WHERE other.survey_id = sg.survey_id AND other.group_id <> $1
          )`,
      [req.params.id],
    );
    if (stranded[0].n > 0) {
      return res.status(409).json({
        error:
          `${stranded[0].n} survey${stranded[0].n === 1 ? '' : 's'} belong${stranded[0].n === 1 ? 's' : ''} ` +
          'to this group and no other, and a survey must always have a group. Add another group ' +
          `to ${stranded[0].n === 1 ? 'it' : 'them'}, or delete ${stranded[0].n === 1 ? 'it' : 'them'}, first.`,
        surveysAffected: stranded[0].n,
      });
    }

    // Members, grants and the surveys' other links to this group cascade away
    // with the row.
    await query('DELETE FROM groups WHERE id = $1', [req.params.id]);

    await audit(req.user.id, 'group.delete', 'group', req.params.id, {});
    return res.json({ ok: true });
  } catch (error) {
    return next(error);
  }
});

/**
 * The groups a user's memberships administer.
 *
 * @param {string} userId
 * @returns {Promise<Set<string>>} Group ids.
 */
async function administeredBy(userId) {
  const { rows } = await query(
    'SELECT group_id FROM group_members WHERE user_id = $1 AND is_admin',
    [userId],
  );
  return new Set(rows.map((row) => row.group_id));
}

/**
 * Loads the target of a membership change and checks it is one that may be made.
 *
 * A super admin is never the target: they reach every group already, so a
 * membership of one grants them nothing and only suggests their access comes
 * from it. The same fact is reported two ways on purpose - a super admin is
 * told plainly that it would be pointless, while anybody else is told the
 * account was not found, because they are not supposed to know super
 * administrators exist at all.
 *
 * @param {object} caller The acting admin.
 * @param {string} userId The target account.
 * @returns {Promise<{tier: string}|{error: string, status: number}>}
 */
async function loadMemberTarget(caller, userId) {
  const { rows } = await query(`SELECT id, tier FROM users WHERE id = $1 AND tier <> 'none'`, [
    userId,
  ]);
  if (rows.length === 0) return { error: 'That admin was not found.', status: 404 };
  if (rows[0].tier === TIERS.SUPER) {
    return caller.isSuperAdmin
      ? { error: SUPER_ADMIN_NEEDS_NO_GROUP, status: 409 }
      : { error: 'That admin was not found.', status: 404 };
  }
  return { tier: rows[0].tier };
}

/**
 * Adds an admin to a group, optionally as an administrator of it.
 *
 * Setting `isAdmin` here is the same decision as the group-admin box at invite
 * time, and carries the same restriction: an administrator of this group may
 * hand their own group's standing on, but spreading somebody across several
 * groups is a super admin's call.
 */
groupsRouter.post('/:id/members', requireGroupControl(), async (req, res, next) => {
  try {
    const { rows: group } = await query('SELECT id FROM groups WHERE id = $1', [req.params.id]);
    if (group.length === 0) return res.status(404).json({ error: 'Group not found.' });

    const userId = String(req.body?.userId ?? '');
    const target = await loadMemberTarget(req.user, userId);
    if (target.error) return res.status(target.status).json({ error: target.error });

    const isAdmin = req.body?.isAdmin === true;
    if (isAdmin) {
      const verdict = mayGrantGroupAdmin(
        req.user,
        await administeredGroups(req.user),
        req.params.id,
        await administeredBy(userId),
      );
      if (verdict.error) return res.status(verdict.status).json({ error: verdict.error });
    }

    await query(
      `INSERT INTO group_members (group_id, user_id, is_admin) VALUES ($1, $2, $3)
       ON CONFLICT (group_id, user_id) DO UPDATE SET is_admin = EXCLUDED.is_admin`,
      [req.params.id, userId, isAdmin],
    );
    await audit(req.user.id, 'group.member_add', 'group', req.params.id, { userId, isAdmin });
    return res.status(201).json({ ok: true });
  } catch (error) {
    return next(error);
  }
});

/**
 * Grants or revokes administration of this group to one of its members.
 *
 * Granting is deliberately self-propagating within a group, at the owner's
 * instruction: an administrator of a group can make further administrators of
 * that same group. What they cannot do is make somebody an administrator of a
 * second group, which stays with super admins. Revoking is unrestricted for
 * whoever administers the group, since it only ever takes away this group's
 * standing and leaves any other group's intact.
 */
groupsRouter.patch('/:id/members/:userId', requireGroupControl(), async (req, res, next) => {
  try {
    const isAdmin = req.body?.isAdmin === true;
    const target = await loadMemberTarget(req.user, req.params.userId);
    if (target.error) return res.status(target.status).json({ error: target.error });

    if (isAdmin) {
      const verdict = mayGrantGroupAdmin(
        req.user,
        await administeredGroups(req.user),
        req.params.id,
        await administeredBy(req.params.userId),
      );
      if (verdict.error) return res.status(verdict.status).json({ error: verdict.error });
    }

    const { rowCount } = await query(
      'UPDATE group_members SET is_admin = $3 WHERE group_id = $1 AND user_id = $2',
      [req.params.id, req.params.userId, isAdmin],
    );
    if (rowCount === 0) {
      return res.status(404).json({ error: 'They are not a member of that group.' });
    }

    await audit(req.user.id, 'group.member_admin', 'group', req.params.id, {
      userId: req.params.userId,
      isAdmin,
    });
    return res.json({ ok: true });
  } catch (error) {
    return next(error);
  }
});

/**
 * Removes an admin from a group.
 *
 * The membership goes, never the account: deleting an account is a super
 * admin's act, on the Users page.
 *
 * Their LAST membership does not go. Membership is the whole of a plain
 * administrator's access now that there is no default group to fall back on, so
 * removing the only one leaves an account that reaches the panel and can do
 * nothing in it - which looks like a bug rather than a decision, and is
 * invisible to whoever did it. The refusal names the two ways out.
 */
groupsRouter.delete('/:id/members/:userId', requireGroupControl(), async (req, res, next) => {
  try {
    const target = await loadMemberTarget(req.user, req.params.userId);
    if (target.error) return res.status(target.status).json({ error: target.error });

    const { rows: held } = await query(
      'SELECT group_id FROM group_members WHERE user_id = $1',
      [req.params.userId],
    );
    if (held.length === 1 && held[0].group_id === req.params.id) {
      return res.status(409).json({
        error:
          'This is the only group they belong to, and an administrator in no group has no access ' +
          'at all. Add them to another group first, or remove their admin access on the Users page.',
        lastGroup: true,
      });
    }

    await query('DELETE FROM group_members WHERE group_id = $1 AND user_id = $2', [
      req.params.id,
      req.params.userId,
    ]);
    await audit(req.user.id, 'group.member_remove', 'group', req.params.id, {
      userId: req.params.userId,
    });
    return res.json({ ok: true });
  } catch (error) {
    return next(error);
  }
});

/**
 * Sets the permissions this group holds over another group's surveys.
 *
 * An empty permission list clears the grant, so unchecking a target removes it
 * rather than leaving a grant that does nothing.
 */
groupsRouter.put('/:id/grants', requireAdmin, async (req, res, next) => {
  try {
    const targetGroupId = String(req.body?.targetGroupId ?? '');
    if (!targetGroupId) return res.status(400).json({ error: 'A target group is required.' });
    if (targetGroupId === req.params.id) {
      return res.status(400).json({ error: 'A group cannot be granted access to its own surveys.' });
    }

    const { rows } = await query('SELECT id FROM groups WHERE id = ANY($1::uuid[])', [
      [req.params.id, targetGroupId],
    ]);
    if (rows.length !== 2) return res.status(404).json({ error: 'Group not found.' });

    const permissions = sanitisePermissions(req.body?.permissions);
    if (permissions.length === 0) {
      await query(
        'DELETE FROM group_grants WHERE source_group_id = $1 AND target_group_id = $2',
        [req.params.id, targetGroupId],
      );
    } else {
      await query(
        `INSERT INTO group_grants (source_group_id, target_group_id, permissions)
              VALUES ($1, $2, $3)
         ON CONFLICT (source_group_id, target_group_id)
              DO UPDATE SET permissions = EXCLUDED.permissions`,
        [req.params.id, targetGroupId, permissions],
      );
    }

    await audit(req.user.id, 'group.grant', 'group', req.params.id, {
      targetGroupId,
      permissions,
    });
    return res.json({ ok: true });
  } catch (error) {
    return next(error);
  }
});
