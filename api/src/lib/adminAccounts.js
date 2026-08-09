/**
 * Pure policy for what an admin account is, and who may change one.
 *
 * An account is a tier - super admin or not - plus the groups it belongs to.
 * There is no per-user permission list: a plain admin's abilities come from
 * their groups' member permissions, resolved against the owning group of
 * whatever they are touching.
 *
 * One of those memberships may also administer its group. That standing lives
 * on the MEMBERSHIP, not the account, so it is always answered as "does this
 * person administer THIS group" and never as "is this person a group admin".
 * Someone placed as an administrator of Selections who is later added to Astro
 * as an ordinary member administers Selections alone.
 *
 * Kept free of database and config imports so the rules are unit-testable.
 */

import { TIERS, isSuper } from './permissionSet.js';

/**
 * The standing a create or update request asks for.
 *
 * Super admin and group admin are one or the other, never both: a super admin
 * bypasses groups entirely, so administering one would mean nothing. The
 * refusal lives here rather than in the form, because a body setting both must
 * be refused whatever the checkboxes did.
 *
 * @param {object|undefined} body The request body.
 * @returns {{tier: string, groupAdmin: boolean}|{error: string}}
 */
export function requestedStanding(body) {
  const superAdmin = body?.superAdmin === true;
  const groupAdmin = body?.groupAdmin === true;

  if (superAdmin && groupAdmin) {
    return {
      error: 'An account is either a super administrator or a group administrator, not both.',
    };
  }

  return { tier: superAdmin ? TIERS.SUPER : TIERS.ADMIN, groupAdmin };
}

/**
 * The group a create request names, if it names one.
 *
 * Null means none was named, which for a super admin means "leave membership
 * alone" - an account in no group resolves against the default group.
 *
 * @param {object|undefined} body The request body.
 * @returns {string|null} A group id, or null.
 */
export function requestedGroupId(body) {
  const raw = body?.groupId;
  if (raw === undefined || raw === null || raw === '') return null;
  return String(raw);
}

/**
 * The groups a membership list administers.
 *
 * @param {Array<{groupId: string, isAdmin?: boolean}>} membership
 * @returns {Set<string>} Group ids whose membership carries administration.
 */
export function administeredGroupIds(membership) {
  return new Set(membership.filter((entry) => entry.isAdmin).map((entry) => entry.groupId));
}

/**
 * Whether a caller may administer one group's membership.
 *
 * Super admins administer every group. Everybody else administers exactly the
 * groups their own membership says so for - being an ordinary member of a
 * group, or an administrator of a different one, grants nothing here.
 *
 * @param {{tier?: string}} user The caller.
 * @param {Array<{groupId: string, isAdmin?: boolean}>} membership Their memberships.
 * @param {string} groupId The group being acted on.
 * @returns {boolean} True when the caller may change that group's membership.
 */
export function administersGroup(user, membership, groupId) {
  if (isSuper(user)) return true;
  return administeredGroupIds(membership).has(groupId);
}

/**
 * The group a newly invited account is placed into.
 *
 * A super admin may name any group, or none at all. A group administrator
 * invites into a group they administer: naming another is refused, and naming
 * none lands the invitee in the group they administer rather than the
 * deployment default, because they are never inviting into somebody else's
 * group. An administrator of several must say which.
 *
 * @param {{tier?: string}} user The caller.
 * @param {Array<{groupId: string, isAdmin?: boolean}>} membership Their memberships.
 * @param {string|null} requested The group id from the request, if any.
 * @returns {{groupId: string|null}|{error: string, status: number}}
 */
export function resolveInviteGroup(user, membership, requested) {
  if (isSuper(user)) return { groupId: requested ?? null };

  const administered = administeredGroupIds(membership);
  if (administered.size === 0) {
    return { error: 'You do not administer a group to invite anybody into.', status: 403 };
  }
  if (!requested) return { groupId: [...administered][0] };
  if (!administered.has(requested)) {
    return { error: 'You can only invite people into a group you administer.', status: 403 };
  }
  return { groupId: requested };
}

/**
 * Whether a caller may hand out the tier being asked for.
 *
 * Only a super admin makes another super admin. Everything below that a group
 * administrator may do inside their own group.
 *
 * @param {{tier?: string}} caller
 * @param {string} tier The tier being granted.
 * @returns {boolean} True when the caller may grant it.
 */
export function mayGrantTier(caller, tier) {
  return isSuper(caller) || tier !== TIERS.SUPER;
}

/**
 * Whether a caller may make somebody an administrator of one group.
 *
 * A group administrator may do this inside the group they administer, and the
 * result is deliberately self-propagating: at the owner's instruction, an
 * administrator of a group can create further administrators of that same
 * group. What they cannot do is spread one person across groups - if the
 * target already administers another group, only a super administrator can add
 * this one, because that is a deployment-shaping decision rather than a
 * decision about one group.
 *
 * Revoking is not routed through here: taking away your own group's standing is
 * always yours to do, whatever the target administers elsewhere.
 *
 * @param {{tier?: string}} caller
 * @param {Set<string>} callerAdministers Groups the caller administers.
 * @param {string} groupId The group whose membership is being promoted.
 * @param {Set<string>} targetAdministers Groups the target already administers.
 * @returns {{ok: true}|{error: string, status: number}}
 */
export function mayGrantGroupAdmin(caller, callerAdministers, groupId, targetAdministers) {
  if (isSuper(caller)) return { ok: true };

  if (!callerAdministers.has(groupId)) {
    return { error: 'You do not administer that group.', status: 403 };
  }

  const elsewhere = [...targetAdministers].filter((id) => id !== groupId);
  if (elsewhere.length > 0) {
    return {
      error:
        'They already administer another group, and only a super administrator can make somebody ' +
        'an administrator of more than one group.',
      status: 403,
    };
  }

  return { ok: true };
}

/**
 * Whether changing or removing this account would leave nobody unrestricted.
 *
 * The count that matters is of super admins alone: a panel full of plain admins
 * can still be locked out of setup, admin management, and plugins. A Discord
 * deployment with bootstrap ids configured has another way in, so it is not
 * stranded by losing its last stored super admin.
 *
 * @param {{targetTier: string, superAdminCount: number,
 *   otherSuperSource?: boolean}} state
 * @returns {boolean} True when the change must be refused.
 */
export function stripsLastSuperAdmin({ targetTier, superAdminCount, otherSuperSource = false }) {
  return targetTier === TIERS.SUPER && superAdminCount <= 1 && !otherSuperSource;
}
