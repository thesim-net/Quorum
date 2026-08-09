import { Router } from 'express';
import { query, transaction } from '../db/pool.js';
import {
  ALL_PERMISSIONS,
  PERMISSION_LABELS,
  TIERS,
  sanitisePermissions,
} from '../lib/permissionSet.js';
import { requireAdmin } from '../middleware/session.js';

/**
 * Group management, mounted under /api/admin/groups.
 *
 * Super-admin only for now: managing who can do what to whose surveys is a
 * deployment-shaping decision, the same class as managing admins. A finer
 * `groups.manage` permission can come later.
 */
export const groupsRouter = Router();

groupsRouter.use(requireAdmin);

const NAME_MAX = 60;

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
 * Lists every group with its members, grants, and member permissions, plus the
 * admins that can be assigned and the permission catalogue for the UI.
 */
groupsRouter.get('/', async (_req, res, next) => {
  try {
    const [groups, members, grants, admins] = await Promise.all([
      query('SELECT id, name, is_default, member_permissions FROM groups ORDER BY is_default DESC, name'),
      query(
        `SELECT gm.group_id, u.id, u.username, u.display_name, u.tier
           FROM group_members gm JOIN users u ON u.id = gm.user_id
          ORDER BY u.tier DESC, u.username`,
      ),
      query('SELECT source_group_id, target_group_id, permissions FROM group_grants'),
      // Anyone who can reach the panel can be assigned; super admins bypass
      // groups but are listed so they can still be added deliberately.
      query(`SELECT id, username, display_name, tier FROM users WHERE tier <> 'none' ORDER BY tier DESC, username`),
    ]);

    const membersByGroup = new Map();
    for (const row of members.rows) {
      if (!membersByGroup.has(row.group_id)) membersByGroup.set(row.group_id, []);
      membersByGroup.get(row.group_id).push({
        id: row.id,
        username: row.username,
        displayName: row.display_name,
        tier: row.tier,
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
      groups: groups.rows.map((group) => ({
        id: group.id,
        name: group.name,
        isDefault: group.is_default,
        memberPermissions: group.member_permissions,
        members: membersByGroup.get(group.id) ?? [],
        grants: grantsByGroup.get(group.id) ?? [],
      })),
      admins: admins.rows.map((row) => ({
        id: row.id,
        username: row.username,
        displayName: row.display_name,
        tier: row.tier,
      })),
      catalogue: ALL_PERMISSIONS.map((key) => ({ key, ...PERMISSION_LABELS[key] })),
    });
  } catch (error) {
    next(error);
  }
});

/** Creates a group. */
groupsRouter.post('/', async (req, res, next) => {
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
 * Renames a group, sets its member permissions, or makes it the default.
 *
 * Renaming the default is allowed; there is always exactly one default, so the
 * only way to move it is to promote another group, which demotes the old one.
 */
groupsRouter.patch('/:id', async (req, res, next) => {
  try {
    const { rows: existing } = await query('SELECT id FROM groups WHERE id = $1', [req.params.id]);
    if (existing.length === 0) return res.status(404).json({ error: 'Group not found.' });

    const body = req.body ?? {};

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

    // Promoting a group to default demotes the previous one in the same
    // transaction, so the single-default index never sees two at once.
    if (body.isDefault === true) {
      await transaction(async (client) => {
        await client.query('UPDATE groups SET is_default = false WHERE is_default');
        await client.query('UPDATE groups SET is_default = true WHERE id = $1', [req.params.id]);
      });
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
 * The default cannot be deleted; deleting any other group reassigns its surveys
 * to the default first, so a survey is never orphaned.
 */
groupsRouter.delete('/:id', async (req, res, next) => {
  try {
    const { rows } = await query('SELECT is_default FROM groups WHERE id = $1', [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ error: 'Group not found.' });
    if (rows[0].is_default) {
      return res.status(409).json({ error: 'The default group cannot be deleted.' });
    }

    await transaction(async (client) => {
      const { rows: def } = await client.query('SELECT id FROM groups WHERE is_default');
      await client.query('UPDATE surveys SET group_id = $2 WHERE group_id = $1', [
        req.params.id,
        def[0].id,
      ]);
      // Members and grants referencing this group cascade away with the row.
      await client.query('DELETE FROM groups WHERE id = $1', [req.params.id]);
    });

    await audit(req.user.id, 'group.delete', 'group', req.params.id, {});
    return res.json({ ok: true });
  } catch (error) {
    return next(error);
  }
});

/** Adds an admin to a group. */
groupsRouter.post('/:id/members', async (req, res, next) => {
  try {
    const { rows: group } = await query('SELECT id FROM groups WHERE id = $1', [req.params.id]);
    if (group.length === 0) return res.status(404).json({ error: 'Group not found.' });

    const userId = String(req.body?.userId ?? '');
    const { rows: user } = await query(
      `SELECT id FROM users WHERE id = $1 AND tier <> 'none'`,
      [userId],
    );
    if (user.length === 0) return res.status(404).json({ error: 'That admin was not found.' });

    await query(
      'INSERT INTO group_members (group_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [req.params.id, userId],
    );
    await audit(req.user.id, 'group.member_add', 'group', req.params.id, { userId });
    return res.status(201).json({ ok: true });
  } catch (error) {
    return next(error);
  }
});

/** Removes an admin from a group. */
groupsRouter.delete('/:id/members/:userId', async (req, res, next) => {
  try {
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
groupsRouter.put('/:id/grants', async (req, res, next) => {
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
