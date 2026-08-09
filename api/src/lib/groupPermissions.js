/**
 * Pure survey-scoped permission resolution.
 *
 * A survey is owned by a group. What an admin may do to it is resolved against
 * that owning group: the union of the member permissions of every group the
 * admin belongs to that IS the owner, plus any cross-group grant whose source
 * is one of the admin's groups and whose target is the owner. Super admins
 * bypass all of this and hold every permission everywhere.
 *
 * Kept free of database and config imports so it is unit-testable on its own.
 */

import { ALL_PERMISSIONS, isSuper } from './permissionSet.js';

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
 * Applies the default-group fallback.
 *
 * An admin who belongs to no group at all is treated as a member of the default
 * group, so a Discord-granted admin (admin by role or channel, in no group) is
 * never locked out. Super admins bypass groups and are returned unchanged.
 *
 * @param {{tier?: string}} user The caller.
 * @param {Array<{groupId: string, memberPermissions: string[]}>} membership The
 *   user's real memberships.
 * @param {{id: string, memberPermissions: string[]}|null} defaultGroup The
 *   default group, or null when none exists.
 * @returns {Array<{groupId: string, memberPermissions: string[]}>} Membership to
 *   resolve against.
 */
export function membershipWithFallback(user, membership, defaultGroup) {
  if (isSuper(user)) return membership;
  if (membership.length > 0) return membership;
  if (!defaultGroup) return [];
  return [{ groupId: defaultGroup.id, memberPermissions: defaultGroup.memberPermissions }];
}
