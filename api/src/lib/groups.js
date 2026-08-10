/**
 * Groups and survey-scoped permission resolution: the database-backed and
 * middleware layer over the pure helpers in groupPermissions.js.
 */

import { query } from '../db/pool.js';
import { ALL_PERMISSIONS, PERMISSIONS, isSuper } from './permissionSet.js';
import { administeredGroupIds, administersGroup } from './adminAccounts.js';
import { current } from './settings.js';
import {
  accessibleGroupIds,
  effectivePermissionsForGroup,
  effectivePermissionsForSurvey,
  groupsWithPermission,
  membershipWithDiscordGroup,
  surveyGroupSelection,
  unionOfPermissions,
} from './groupPermissions.js';

// Re-exported so call sites can reach the pure helpers through one module.
export {
  accessibleGroupIds,
  effectivePermissionsForGroup,
  effectivePermissionsForSurvey,
  groupsWithPermission,
  membershipWithDiscordGroup,
  surveyGroupSelection,
  unionOfPermissions,
};

/**
 * Loads the group context a permission decision needs for one user.
 *
 * Each membership carries whether it administers its group, since that standing
 * belongs to the membership rather than to the account.
 *
 * `discordGroup` is the group the Discord plugin puts role- and channel-derived
 * admins in. It is loaded here rather than at each call site so that the one
 * kind of admin nobody chose a group for still resolves to something; it is
 * only applied to those accounts, by `membershipWithDiscordGroup`.
 *
 * @param {string} userId
 * @returns {Promise<{membership: Array<{groupId: string, memberPermissions: string[],
 *   isAdmin: boolean}>,
 *   grants: Array<{sourceGroupId: string, targetGroupId: string, permissions: string[]}>,
 *   discordGroup: {id: string, memberPermissions: string[]}|null}>}
 */
export async function loadGroupContext(userId) {
  const discordGroupId = current().discord.adminGroupId ?? null;

  const [members, grants, derived] = await Promise.all([
    query(
      `SELECT g.id, g.member_permissions, m.is_admin
         FROM group_members m JOIN groups g ON g.id = m.group_id
        WHERE m.user_id = $1
        ORDER BY g.name`,
      [userId],
    ),
    query('SELECT source_group_id, target_group_id, permissions FROM group_grants'),
    discordGroupId
      ? query('SELECT id, member_permissions FROM groups WHERE id = $1', [discordGroupId])
      : Promise.resolve({ rows: [] }),
  ]);

  return {
    membership: members.rows.map((row) => ({
      groupId: row.id,
      memberPermissions: row.member_permissions,
      isAdmin: row.is_admin,
    })),
    grants: grants.rows.map((row) => ({
      sourceGroupId: row.source_group_id,
      targetGroupId: row.target_group_id,
      permissions: row.permissions,
    })),
    discordGroup: derived.rows[0]
      ? { id: derived.rows[0].id, memberPermissions: derived.rows[0].member_permissions }
      : null,
  };
}

/**
 * The memberships a decision about this caller resolves against.
 *
 * Their real ones, plus the Discord landing group when their admin tier came
 * from a role or a channel. There is no other fallback: an administrator in no
 * group resolves against nothing and can do nothing.
 *
 * @param {{tier?: string, discordAdminGroupId?: string|null}} user The caller.
 * @param {{membership: Array<object>, discordGroup: object|null}} context
 * @returns {Array<{groupId: string, memberPermissions: string[]}>} Membership.
 */
export const resolvedMembership = (user, context) =>
  membershipWithDiscordGroup(user, context.membership, context.discordGroup);

/**
 * The groups a survey belongs to.
 *
 * @param {string} surveyId
 * @returns {Promise<string[]>} Group ids, empty when the survey does not exist.
 */
export async function surveyGroupIds(surveyId) {
  const { rows } = await query('SELECT group_id FROM survey_groups WHERE survey_id = $1', [
    surveyId,
  ]);
  return rows.map((row) => row.group_id);
}

/**
 * The permissions a user holds over the surveys of one group.
 *
 * @param {{tier?: string, id: string}} user The caller.
 * @param {string} groupId The group.
 * @returns {Promise<Set<string>>} The permissions the user can exercise.
 */
export async function userGroupPermissions(user, groupId) {
  if (isSuper(user)) return new Set(ALL_PERMISSIONS);

  const context = await loadGroupContext(user.id);
  return effectivePermissionsForGroup(
    user,
    groupId,
    resolvedMembership(user, context),
    context.grants,
  );
}

/**
 * Every permission a user can exercise over any group, against the database.
 *
 * Used for the coarse checks that are not about one particular survey, and for
 * telling the client what to bother showing. Never a substitute for
 * `requireSurveyPermission`, which is what actually guards a survey.
 *
 * @param {{tier?: string, id: string}} user The caller.
 * @returns {Promise<Set<string>>} The permissions held over at least one group.
 */
export async function userPermissionUnion(user) {
  if (isSuper(user)) return new Set(ALL_PERMISSIONS);

  const context = await loadGroupContext(user.id);
  return unionOfPermissions(user, resolvedMembership(user, context), context.grants);
}

/**
 * The groups a caller may place a survey in, in the order they are offered.
 *
 * Every group for a super admin; for anybody else, exactly the groups where
 * they hold surveys.write, whether from their own membership or from a
 * cross-group grant. Nothing is preselected anywhere: there is no default group
 * to fall back on, so choosing is the creator's to do.
 *
 * @param {{tier?: string, id: string}} user The caller.
 * @returns {Promise<Array<{id: string, name: string}>>} Groups they may write in.
 */
export async function writableGroups(user) {
  const { rows } = await query('SELECT id, name FROM groups ORDER BY name');
  if (isSuper(user)) return rows.map((row) => ({ id: row.id, name: row.name }));

  const context = await loadGroupContext(user.id);
  return groupsWithPermission(
    user,
    rows,
    resolvedMembership(user, context),
    context.grants,
    PERMISSIONS.SURVEYS_WRITE,
  );
}

/**
 * Validates and authorises the groups a survey is being placed in.
 *
 * A survey must always belong to at least one group, and the caller may only
 * add it to groups they can write in. There is no default and nothing is
 * implied: an empty list is refused rather than quietly filled in.
 *
 * `current` is what the survey already belongs to, and only matters on an
 * update. A survey shared with a group the caller cannot write in is still
 * theirs to edit - one group's surveys.write covers the whole survey - but that
 * other group's claim on it is not theirs to add or drop. So groups they cannot
 * write in are left exactly as they found them, which is why the two directions
 * are checked separately rather than by one sweep over the new list.
 *
 * @param {{tier?: string, id: string}} user The caller.
 * @param {*} requested Whatever the request sent as the group list.
 * @param {string[]} current The groups the survey belongs to now.
 * @returns {Promise<{groupIds: string[]}|{error: string, status: number}>}
 */
export async function resolveSurveyGroups(user, requested, current = []) {
  const selection = surveyGroupSelection(requested);
  if (selection.error) return selection;
  const ids = selection.groupIds;

  const { rows } = await query('SELECT id FROM groups WHERE id = ANY($1::uuid[])', [ids]);
  if (rows.length !== ids.length) {
    return { error: 'One of those groups does not exist.', status: 404 };
  }

  if (isSuper(user)) return { groupIds: ids };

  const context = await loadGroupContext(user.id);
  const membership = resolvedMembership(user, context);
  const mayWrite = (groupId) =>
    effectivePermissionsForGroup(user, groupId, membership, context.grants).has(
      PERMISSIONS.SURVEYS_WRITE,
    );

  const held = new Set(current);
  const wanted = new Set(ids);

  for (const groupId of ids) {
    if (!held.has(groupId) && !mayWrite(groupId)) {
      return { error: 'You cannot create surveys in one of those groups.', status: 403 };
    }
  }

  for (const groupId of current) {
    if (!wanted.has(groupId) && !mayWrite(groupId)) {
      return {
        error: 'You cannot take this survey away from a group you cannot create surveys in.',
        status: 403,
      };
    }
  }

  return { groupIds: ids };
}

/**
 * Middleware that authorises one permission against a survey's groups.
 *
 * Holding the permission over any ONE of them is enough: each group a survey
 * belongs to owns it as fully as the others. Super admins pass straight
 * through, and a missing survey is a 404 so the guard behaves like the routes
 * it fronts. A survey that has somehow been left with no groups is refused
 * rather than opened up, since there is nothing to resolve against.
 *
 * @param {string} permission One of PERMISSIONS.
 * @returns {import('express').RequestHandler}
 */
export function requireSurveyPermission(permission) {
  return async (req, res, next) => {
    try {
      if (!req.user) return res.status(401).json({ error: 'Sign in to continue.' });
      if (isSuper(req.user)) return next();

      const { rows } = await query('SELECT id FROM surveys WHERE id = $1', [req.params.id]);
      if (rows.length === 0) return res.status(404).json({ error: 'Survey not found.' });

      const groupIds = await surveyGroupIds(req.params.id);
      const context = await loadGroupContext(req.user.id);
      const permissions = effectivePermissionsForSurvey(
        req.user,
        groupIds,
        resolvedMembership(req.user, context),
        context.grants,
      );

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

/**
 * The groups a user administers, resolved against the database.
 *
 * Empty for anybody whose memberships carry no administration. Super admins are
 * not enumerated here: they administer every group, which call sites handle by
 * checking `isSuper` first rather than by listing every group there is.
 *
 * @param {{tier?: string, id: string}} user The caller.
 * @returns {Promise<Set<string>>} Group ids they administer.
 */
export async function administeredGroups(user) {
  const context = await loadGroupContext(user.id);
  return administeredGroupIds(context.membership);
}

/**
 * Middleware that requires the caller to administer the group being acted on.
 *
 * Always about ONE group: administering Selections says nothing about Astro,
 * so acting on a group the caller does not administer is refused here rather
 * than merely hidden by the client. Super admins pass straight through.
 *
 * @param {string} param The route parameter holding the group id.
 * @returns {import('express').RequestHandler}
 */
export function requireGroupControl(param = 'id') {
  return async (req, res, next) => {
    try {
      if (!req.user) return res.status(401).json({ error: 'Sign in to continue.' });
      if (isSuper(req.user)) return next();

      const context = await loadGroupContext(req.user.id);
      if (!administersGroup(req.user, context.membership, req.params[param])) {
        return res.status(403).json({ error: 'You do not administer that group.' });
      }
      return next();
    } catch (error) {
      return next(error);
    }
  };
}

/**
 * Middleware that authorises one permission against any group at all.
 *
 * For the handful of endpoints that serve no particular survey - listing a
 * Discord server's roles and channels so a group's audience can be configured,
 * say - where there is no owning group to resolve against. Anything that does
 * name a survey uses `requireSurveyPermission` instead, which is narrower.
 *
 * @param {string} permission One of PERMISSIONS.
 * @returns {import('express').RequestHandler}
 */
export function requireAnyGroupPermission(permission) {
  return async (req, res, next) => {
    try {
      if (!req.user) return res.status(401).json({ error: 'Sign in to continue.' });
      if (isSuper(req.user)) return next();

      const permissions = await userPermissionUnion(req.user);
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
