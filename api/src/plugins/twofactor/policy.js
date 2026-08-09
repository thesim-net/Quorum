/**
 * Pure two-factor requirement policy.
 *
 * Kept free of config, database, and settings imports so the precedence between
 * the plugin switch, the deployment-wide "require for all admins" switch, the
 * per-account flag, and existing enrolment is unit-testable on its own.
 */

/**
 * Whether an account effectively needs 2FA, from the pieces that decide it.
 *
 * The requirement holds only while the plugin is enabled. On top of that, the
 * deployment-wide switch forces every admin, the per-account flag forces one
 * admin, and an already-enrolled account keeps being challenged.
 *
 * @param {{pluginEnabled: boolean, requireAllAdmins: boolean, isAdmin: boolean,
 *   totpRequired: boolean, enrolled: boolean}} state
 * @returns {boolean} True when 2FA applies to the account.
 */
export function effectiveRequirement({
  pluginEnabled,
  requireAllAdmins,
  isAdmin,
  totpRequired,
  enrolled,
}) {
  if (!pluginEnabled) return false;
  if (requireAllAdmins && isAdmin) return true;
  if (totpRequired) return true;
  return Boolean(enrolled);
}
