/**
 * Who reaches a group, counted as three separate populations.
 *
 * A bare member count misrepresents a group twice over. It folds the people who
 * RUN the group in with the people who merely belong to it, and it says nothing
 * about super administrators, who reach every group without belonging to any -
 * they hold no membership at all, deliberately, so counting them as members
 * would state the opposite of the model.
 *
 * So: members, administrators, and super administrators, kept apart and never
 * double counted. The super administrator count is the deployment's, identical
 * for every group, which is why it is passed in rather than derived from the
 * group.
 *
 * Kept free of React so the wording is unit-testable on its own.
 */

/**
 * A count with its noun, pluralised.
 *
 * @param {number} count
 * @param {string} noun Singular form.
 * @returns {string} e.g. "1 member", "2 members".
 */
const plural = (count, noun) => `${count} ${noun}${count === 1 ? '' : 's'}`;

/**
 * Splits a group's memberships into those who run it and those who do not.
 *
 * Somebody who administers the group is counted there and nowhere else, so a
 * group whose only entry is an administrator reads "0 members, 1 admin".
 *
 * @param {Array<{administers?: boolean}>} members The group's memberships.
 * @returns {{members: number, admins: number}} The two counts.
 */
export function countMemberships(members = []) {
  const admins = members.filter((member) => member.administers).length;
  return { members: members.length - admins, admins };
}

/**
 * The line shown under a group's name in the index.
 *
 * Members and administrators are always shown, zero included: "0 members" is a
 * fact about the group worth seeing. Super administrators are omitted when
 * there are none, because a deployment with no super administrator is a
 * different situation entirely and not something to report per group.
 *
 * @param {Array<{administers?: boolean}>} members The group's memberships.
 * @param {number} superAdminCount Super administrators in the deployment.
 * @returns {string} e.g. "0 members · 1 admin · 2 super admins".
 */
export function groupCountLine(members = [], superAdminCount = 0) {
  const counts = countMemberships(members);
  const parts = [plural(counts.members, 'member'), plural(counts.admins, 'admin')];
  if (superAdminCount > 0) parts.push(plural(superAdminCount, 'super admin'));
  return parts.join(' · ');
}
