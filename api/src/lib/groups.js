/**
 * Groups and survey-scoped permission resolution: the database-backed and
 * middleware layer over the pure helpers in groupPermissions.js.
 */

import { query } from '../db/pool.js';
import { PERMISSIONS, isSuper } from './permissionSet.js';
import {
  accessibleGroupIds,
  effectivePermissionsForGroup,
  membershipWithFallback,
} from './groupPermissions.js';

// Re-exported so call sites can reach the pure helpers through one module.
export { accessibleGroupIds, effectivePermissionsForGroup, membershipWithFallback };

/**
 * Loads the group context a permission decision needs for one user.
 *
 * @param {string} userId
 * @returns {Promise<{membership: Array<{groupId: string, memberPermissions: string[]}>,
 *   grants: Array<{sourceGroupId: string, targetGroupId: string, permissions: string[]}>,
 *   defaultGroup: {id: string, memberPermissions: string[]}|null}>}
 */
export async function loadGroupContext(userId) {
  const [members, grants, def] = await Promise.all([
    query(
      `SELECT g.id, g.member_permissions
         FROM group_members m JOIN groups g ON g.id = m.group_id
        WHERE m.user_id = $1`,
      [userId],
    ),
    query('SELECT source_group_id, target_group_id, permissions FROM group_grants'),
    query('SELECT id, member_permissions FROM groups WHERE is_default'),
  ]);

  return {
    membership: members.rows.map((row) => ({
      groupId: row.id,
      memberPermissions: row.member_permissions,
    })),
    grants: grants.rows.map((row) => ({
      sourceGroupId: row.source_group_id,
      targetGroupId: row.target_group_id,
      permissions: row.permissions,
    })),
    defaultGroup: def.rows[0]
      ? { id: def.rows[0].id, memberPermissions: def.rows[0].member_permissions }
      : null,
  };
}

/**
 * The permissions a user holds over one group, resolved against the database.
 *
 * @param {{tier?: string, permissions?: string[]}} user The caller.
 * @param {string} ownerGroupId The owning group.
 * @returns {Promise<Set<string>>} The permissions the user can exercise.
 */
export async function userGroupPermissions(user, ownerGroupId) {
  if (isSuper(user)) return new Set(ALL_PERMISSIONS);

  const context = await loadGroupContext(user.id);
  // Pre-migration safety: with no groups at all, fall back to the legacy global
  // permission list so a deployment that has not run 010 yet still works.
  if (context.membership.length === 0 && !context.defaultGroup) {
    return new Set(user.permissions ?? []);
  }

  const membership = membershipWithFallback(user, context.membership, context.defaultGroup);
  return effectivePermissionsForGroup(user, ownerGroupId, membership, context.grants);
}

/**
 * Chooses and authorises the group a new survey will belong to.
 *
 * The caller may name a group; when they do not, it defaults to their first
 * group, or the deployment default. Either way they must hold surveys.write
 * over the chosen group. Super admins may create in any group.
 *
 * @param {{tier?: string, id: string}} user The caller.
 * @param {string|null|undefined} requestedGroupId A group id from the request.
 * @returns {Promise<{groupId: string}|{error: string, status: number}>}
 */
export async function resolveCreateGroup(user, requestedGroupId) {
  const requested = requestedGroupId ? String(requestedGroupId) : null;

  if (isSuper(user)) {
    if (requested) {
      const { rows } = await query('SELECT id FROM groups WHERE id = $1', [requested]);
      if (rows.length === 0) return { error: 'That group does not exist.', status: 404 };
      return { groupId: requested };
    }
    const { rows } = await query('SELECT id FROM groups WHERE is_default');
    if (rows.length === 0) return { error: 'No group is available to own the survey.', status: 409 };
    return { groupId: rows[0].id };
  }

  const context = await loadGroupContext(user.id);
  const membership = membershipWithFallback(user, context.membership, context.defaultGroup);
  const groupId = requested ?? membership[0]?.groupId ?? context.defaultGroup?.id ?? null;
  if (!groupId) return { error: 'You are not a member of any group.', status: 403 };

  const permissions = effectivePermissionsForGroup(user, groupId, membership, context.grants);
  if (!permissions.has(PERMISSIONS.SURVEYS_WRITE)) {
    return { error: 'You cannot create surveys in that group.', status: 403 };
  }
  return { groupId };
}

/**
 * Middleware that authorises one permission against the owning group of the
 * survey named by `req.params.id`.
 *
 * Super admins pass straight through. A missing survey is a 404 so the guard
 * behaves like the routes it fronts.
 *
 * @param {string} permission One of PERMISSIONS.
 * @returns {import('express').RequestHandler}
 */
export function requireSurveyPermission(permission) {
  return async (req, res, next) => {
    try {
      if (!req.user) return res.status(401).json({ error: 'Sign in to continue.' });
      if (isSuper(req.user)) return next();

      const { rows } = await query('SELECT group_id FROM surveys WHERE id = $1', [req.params.id]);
      if (rows.length === 0) return res.status(404).json({ error: 'Survey not found.' });

      const permissions = await userGroupPermissions(req.user, rows[0].group_id);
      if (!permissions.has(permission)) {
        return res.status(403).json({
          error: 'You do not have permission to do that.',
          required: permission,
        });
      }
      return next();
    } catch (error) {
      return next(error);
    }
  };
}
