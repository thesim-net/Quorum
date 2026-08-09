/**
 * Access tiers and the permissions groups hand out.
 *
 * A super admin is unrestricted: every permission, managing other admins, and
 * re-running setup. A plain admin holds nothing of their own - what they may do
 * comes from the groups they belong to, resolved per survey in
 * groupPermissions.js. A plain admin cannot see super admins at all, so the
 * people who run the deployment are not enumerable by the people who merely
 * help run surveys.
 */

export const TIERS = {
  NONE: 'none',
  ADMIN: 'admin',
  SUPER: 'super_admin',
};

/**
 * Whether a user is a super admin.
 *
 * @param {{tier?: string}|null} user
 * @returns {boolean} True for unrestricted access.
 */
export const isSuper = (user) => user?.tier === TIERS.SUPER;

/**
 * Whether a user may reach the admin panel at all.
 *
 * @param {{tier?: string}|null} user
 * @returns {boolean} True for either admin tier.
 */
export const hasPanel = (user) => Boolean(user) && user.tier !== TIERS.NONE && Boolean(user.tier);

export const PERMISSIONS = {
  SURVEYS_WRITE: 'surveys.write',
  SURVEYS_PUBLISH: 'surveys.publish',
  SURVEYS_DELETE: 'surveys.delete',
  RESULTS_READ: 'results.read',
};

/** Every grantable permission, in the order the admin panel lists them. */
export const ALL_PERMISSIONS = [
  PERMISSIONS.SURVEYS_WRITE,
  PERMISSIONS.SURVEYS_PUBLISH,
  PERMISSIONS.SURVEYS_DELETE,
  PERMISSIONS.RESULTS_READ,
];

/** Human-readable labels, shared with the frontend through the API. */
export const PERMISSION_LABELS = {
  [PERMISSIONS.SURVEYS_WRITE]: {
    label: 'Create and edit surveys',
    detail: 'Write questions and change settings. Does not include opening a survey.',
  },
  [PERMISSIONS.SURVEYS_PUBLISH]: {
    label: 'Open and close surveys',
    detail: 'Control whether a survey is accepting responses.',
  },
  [PERMISSIONS.SURVEYS_DELETE]: {
    label: 'Delete surveys',
    detail: 'Permanently remove a survey and every response to it.',
  },
  [PERMISSIONS.RESULTS_READ]: {
    label: 'View results and export data',
    detail:
      'See charts, metrics, and downloads. Includes respondent usernames on surveys that record them.',
  },
};

/**
 * Filters a submitted permission list down to known values.
 *
 * @param {*} input Whatever the client sent.
 * @returns {string[]} Valid, de-duplicated permissions.
 */
export function sanitisePermissions(input) {
  if (!Array.isArray(input)) return [];
  return [...new Set(input.map(String).filter((p) => ALL_PERMISSIONS.includes(p)))];
}
