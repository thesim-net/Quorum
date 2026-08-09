/**
 * What removing an admin costs, in the words the confirmation shows.
 *
 * "Removed" understates it. Revoking access also clears every group membership
 * the account holds, in one act, and the cases where a mistake is most
 * expensive - a super administrator, or somebody who administers groups - are
 * exactly the ones a one-line prompt would fail to mention. So the prompt says
 * what actually happens, naming the groups involved.
 *
 * Kept free of React so the wording is unit-testable on its own.
 */

/**
 * Joins names into a readable list.
 *
 * @param {string[]} names
 * @returns {string} "A", "A and B", or "A, B and C".
 */
export function nameList(names) {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/**
 * The consequences of revoking one admin's access, most serious first.
 *
 * @param {{tier?: string, groups?: Array<{name: string, administers?: boolean}>}} admin
 *   An entry from the admins listing.
 * @returns {string[]} One sentence per consequence, all of them true.
 */
export function removalConsequences(admin) {
  const groups = admin?.groups ?? [];
  const administered = groups.filter((group) => group.administers).map((group) => group.name);
  const consequences = [];

  if (admin?.tier === 'super_admin') {
    consequences.push(
      'They are a super administrator, so this takes away unrestricted access to the deployment.',
    );
  }
  if (administered.length > 0) {
    consequences.push(
      `They administer ${nameList(administered)}, and will no longer run ${
        administered.length === 1 ? 'its' : 'their'
      } membership.`,
    );
  }

  consequences.push('They lose administrator access and can no longer reach the panel.');

  if (groups.length > 0) {
    consequences.push(`Their membership of ${nameList(groups.map((g) => g.name))} is cleared.`);
  }

  consequences.push('The account itself is kept, and can be granted access again later.');
  return consequences;
}
