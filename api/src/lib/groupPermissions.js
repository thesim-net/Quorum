/**
 * Pure survey-scoped permission resolution.
 *
 * A survey belongs to one or more groups. What an admin may do to it is
 * resolved against those groups: for one group, the union of the member
 * permissions of every group the admin belongs to that IS that group, plus any
 * cross-group grant whose source is one of the admin's groups and whose target
 * is that group. Across several, the union again - holding surveys.write over
 * any one of a survey's groups is enough to edit it, because each of those
 * groups owns it every bit as much as the others do.
 *
 * Super admins bypass all of this and hold every permission everywhere.
 *
 * Kept free of database and config imports so it is unit-testable on its own.
 */

import { ALL_PERMISSIONS, isSuper } from './permissionSet.js';

/**
 * Reads the group list a survey is being created or updated with.
 *
 * A survey must always belong to at least one group, and there is nothing left
 * to fall back on if it does not: no default group, and no owner column. So an
 * empty list is refused rather than filled in - at creation, where it means
 * nothing was chosen, and at update, where it means the last group was being
 * taken away.
 *
 * The database cannot state this on its own. A row of `survey_groups` cannot
 * see whether it is the last one for its survey, and a constraint spanning two
 * tables would need a trigger. This is where it is enforced instead.
 *
 * @param {*} requested Whatever the request sent; one id or a list of them.
 * @returns {{groupIds: string[]}|{error: string, status: number}}
 */
export function surveyGroupSelection(requested) {
  const list = Array.isArray(requested) ? requested : requested ? [requested] : [];
  const groupIds = [
    ...new Set(list.map((id) => String(id ?? '').trim()).filter(Boolean)),
  ];

  if (groupIds.length === 0) {
    return { error: 'Choose at least one group for this survey.', status: 400 };
  }
  return { groupIds };
}

/**
 * The groups a caller may act in, filtered by one permission.
 *
 * What the group selectors are built from: a creator is only ever offered the
 * groups they could actually place a survey in. Nothing is preselected by any
 * caller of this - there is no default group to preselect.
 *
 * @param {{tier?: string}} user The caller.
 * @param {Array<{id: string, name: string}>} groups Every group there is.
 * @param {Array<{groupId: string, memberPermissions: string[]}>} membership The
 *   caller's memberships.
 * @param {Array<{sourceGroupId: string, targetGroupId: string,
 *   permissions: string[]}>} grants Every cross-group grant.
 * @param {string} permission The permission they must hold.
 * @returns {Array<{id: string, name: string}>} The groups to offer.
 */
export function groupsWithPermission(user, groups, membership, grants, permission) {
  if (isSuper(user)) return groups.map((group) => ({ id: group.id, name: group.name }));

  return groups
    .filter((group) =>
      effectivePermissionsForGroup(user, group.id, membership, grants).has(permission),
    )
    .map((group) => ({ id: group.id, name: group.name }));
}

/**
 * Adds the valid permissions from a list to a set.
 *
 * @param {Set<string>} into Target set.
 * @param {string[]} list Permission strings, possibly with unknown values.
 */
function addValid(into, list) {
  for (const permission of list ?? []) {
    if (ALL_PERMISSIONS.includes(permission)) into.add(permission);
  }
}

/**
 * The permissions a user holds over surveys owned by one group.
 *
 * @param {{tier?: string}} user The caller.
 * @param {string} ownerGroupId The group that owns the survey in question.
 * @param {Array<{groupId: string, memberPermissions: string[]}>} membership The
 *   groups the user belongs to, each with that group's member permissions.
 * @param {Array<{sourceGroupId: string, targetGroupId: string,
 *   permissions: string[]}>} grants Every cross-group grant.
 * @returns {Set<string>} The permissions the user can exercise on that group.
 */
export function effectivePermissionsForGroup(user, ownerGroupId, membership, grants) {
  if (isSuper(user)) return new Set(ALL_PERMISSIONS);

  const permissions = new Set();
  const userGroupIds = new Set(membership.map((entry) => entry.groupId));

  // Being a member of the owning group grants that group's member permissions.
  for (const entry of membership) {
    if (entry.groupId === ownerGroupId) addValid(permissions, entry.memberPermissions);
  }

  // A grant from one of the user's groups onto the owner adds its permissions.
  for (const grant of grants) {
    if (grant.targetGroupId === ownerGroupId && userGroupIds.has(grant.sourceGroupId)) {
      addValid(permissions, grant.permissions);
    }
  }

  return permissions;
}

/**
 * The permissions a user holds over a survey, given the groups it belongs to.
 *
 * The union across those groups: a survey placed on Astro and on Public is
 * editable by anyone Astro lets edit, OR anyone Public lets edit. Sharing a
 * survey with a second group is what hands that group the same say over it, so
 * requiring the permission in every group instead would make a shared survey
 * unmanageable by all of them.
 *
 * @param {{tier?: string}} user The caller.
 * @param {string[]} groupIds The groups the survey belongs to.
 * @param {Array<{groupId: string, memberPermissions: string[]}>} membership The
 *   groups the user belongs to, each with that group's member permissions.
 * @param {Array<{sourceGroupId: string, targetGroupId: string,
 *   permissions: string[]}>} grants Every cross-group grant.
 * @returns {Set<string>} The permissions the user can exercise on that survey.
 */
export function effectivePermissionsForSurvey(user, groupIds, membership, grants) {
  if (isSuper(user)) return new Set(ALL_PERMISSIONS);

  const permissions = new Set();
  for (const groupId of groupIds ?? []) {
    for (const permission of effectivePermissionsForGroup(user, groupId, membership, grants)) {
      permissions.add(permission);
    }
  }
  return permissions;
}

/**
 * Every permission a user can exercise somewhere, over any group.
 *
 * The union of their own groups' member permissions and of every grant those
 * groups hold. Advisory only: it answers "can this person publish anything at
 * all", never "may this person publish THIS survey", which is always resolved
 * against the owning group by effectivePermissionsForGroup.
 *
 * @param {{tier?: string}} user The caller.
 * @param {Array<{groupId: string, memberPermissions: string[]}>} membership The
 *   groups the user belongs to, each with that group's member permissions.
 * @param {Array<{sourceGroupId: string, permissions: string[]}>} grants Every
 *   cross-group grant.
 * @returns {Set<string>} The permissions the user holds over at least one group.
 */
export function unionOfPermissions(user, membership, grants) {
  if (isSuper(user)) return new Set(ALL_PERMISSIONS);

  const permissions = new Set();
  const userGroupIds = new Set(membership.map((entry) => entry.groupId));

  for (const entry of membership) addValid(permissions, entry.memberPermissions);
  for (const grant of grants) {
    if (userGroupIds.has(grant.sourceGroupId)) addValid(permissions, grant.permissions);
  }

  return permissions;
}

/**
 * The ids of every group whose surveys a user can see.
 *
 * Their own groups, plus every group they hold a grant onto. Super admins see
 * all surveys, which the caller handles separately rather than enumerating here.
 *
 * @param {{tier?: string}} _user The caller (unused; super is handled upstream).
 * @param {Array<{groupId: string}>} membership The groups the user belongs to.
 * @param {Array<{sourceGroupId: string, targetGroupId: string}>} grants Every
 *   cross-group grant.
 * @returns {Set<string>} Accessible group ids.
 */
export function accessibleGroupIds(_user, membership, grants) {
  const ids = new Set(membership.map((entry) => entry.groupId));
  const userGroupIds = new Set(ids);
  for (const grant of grants) {
    if (userGroupIds.has(grant.sourceGroupId)) ids.add(grant.targetGroupId);
  }
  return ids;
}

/**
 * Adds the group that Discord role- and channel-derived admins land in.
 *
 * There is no default-group fallback any more: an administrator who belongs to
 * no group holds nothing, which is the point of removing it. That leaves one
 * account nobody ever chose a group for - the admin whose tier comes from
 * holding a Discord role or seeing a Discord channel, resolved per request. The
 * Discord plugin names the group those accounts resolve against, and it is
 * added here on top of whatever memberships they really hold.
 *
 * With no such group configured they resolve to nothing, which is the safe
 * reading: no group has been chosen for them, so none is guessed. Super admins
 * bypass groups and are returned unchanged.
 *
 * @param {{tier?: string, discordAdminGroupId?: string|null}} user The caller;
 *   `discordAdminGroupId` is set by the session only when their admin tier came
 *   from a Discord role or channel.
 * @param {Array<{groupId: string, memberPermissions: string[]}>} membership The
 *   user's real memberships.
 * @param {{id: string, memberPermissions: string[]}|null} discordGroup The
 *   configured landing group, or null when none is set.
 * @returns {Array<{groupId: string, memberPermissions: string[]}>} Membership to
 *   resolve against.
 */
export function membershipWithDiscordGroup(user, membership, discordGroup) {
  if (isSuper(user)) return membership;
  if (!user?.discordAdminGroupId || !discordGroup) return membership;
  if (membership.some((entry) => entry.groupId === discordGroup.id)) return membership;

  return [
    ...membership,
    {
      groupId: discordGroup.id,
      memberPermissions: discordGroup.memberPermissions,
      // Derived access never administers the group it lands in: administering
      // one is a membership somebody granted, not something a Discord role
      // confers.
      isAdmin: false,
    },
  ];
}
