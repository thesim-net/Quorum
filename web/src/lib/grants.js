/**
 * Pure helpers for the cross-group access editor.
 *
 * The groups endpoint hands each group back with the grants it holds over
 * others. The editor asks the reverse questions - "does this pair already have
 * a grant" and "what grants exist at all" - so they live here, free of React
 * and testable on their own.
 *
 * The API deletes a grant whose permission list is emptied, so a grant with no
 * permissions is treated as no grant at all.
 */

/**
 * The permissions a source group already holds over a target group.
 *
 * @param {Array<{id: string, grants: Array<{targetGroupId: string, permissions: string[]}>}>} groups
 *   Every group, as returned by GET /admin/groups.
 * @param {string} sourceId The group being granted access.
 * @param {string} targetId The group whose surveys are reached.
 * @returns {string[]|null} The granted permissions, or null when there is no grant.
 */
export function findGrant(groups, sourceId, targetId) {
  if (!sourceId || !targetId || sourceId === targetId) return null;
  const source = groups.find((group) => group.id === sourceId);
  const grant = source?.grants?.find((entry) => entry.targetGroupId === targetId);
  return grant?.permissions?.length ? [...grant.permissions] : null;
}

/**
 * Every grant that exists, flattened into one row each for listing.
 *
 * Rows are ordered by source then target name so the list is stable across
 * reloads. A grant pointing at a group that is no longer there is skipped: it
 * cannot be shown or edited, and the server drops it with the group anyway.
 *
 * @param {Array<{id: string, name: string, grants: Array<{targetGroupId: string,
 *   permissions: string[]}>}>} groups Every group.
 * @returns {Array<{sourceId: string, sourceName: string, targetId: string,
 *   targetName: string, permissions: string[]}>} One row per grant.
 */
export function listGrants(groups) {
  const names = new Map(groups.map((group) => [group.id, group.name]));
  const rows = [];

  for (const source of groups) {
    for (const grant of source.grants ?? []) {
      if (!names.has(grant.targetGroupId) || !grant.permissions?.length) continue;
      rows.push({
        sourceId: source.id,
        sourceName: source.name,
        targetId: grant.targetGroupId,
        targetName: names.get(grant.targetGroupId),
        permissions: [...grant.permissions],
      });
    }
  }

  return rows.sort(
    (a, b) => a.sourceName.localeCompare(b.sourceName) || a.targetName.localeCompare(b.targetName),
  );
}

/**
 * The groups a grant from one source may target.
 *
 * A group is never offered access to itself: the API rejects it outright, so
 * the UI does not present it.
 *
 * @param {Array<{id: string}>} groups Every group.
 * @param {string} sourceId The source group, if one is chosen yet.
 * @returns {Array<object>} The groups that can be targeted.
 */
export function grantTargets(groups, sourceId) {
  return groups.filter((group) => group.id !== sourceId);
}

/**
 * Adds or removes one permission from a working selection.
 *
 * @param {string[]} current The current selection.
 * @param {string} key The permission key toggled.
 * @returns {string[]} The updated selection.
 */
export function togglePermission(current, key) {
  return current.includes(key) ? current.filter((p) => p !== key) : [...current, key];
}

/**
 * Permission keys rendered as their catalogue labels, in catalogue order.
 *
 * @param {Array<{key: string, label: string}>} catalogue The permission catalogue.
 * @param {string[]} keys The keys held.
 * @returns {string[]} The labels, with unknown keys dropped.
 */
export function permissionNames(catalogue, keys) {
  return catalogue.filter((entry) => keys.includes(entry.key)).map((entry) => entry.label);
}
