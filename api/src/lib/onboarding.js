/**
 * Pure account-onboarding policy.
 *
 * An administrator ends up holding both identities: a local username and
 * password, and a linked Discord account. Each is a forced step, so they are
 * resolved here into ONE flow with a fixed order and at most one step
 * outstanding at a time. Nothing else decides either gate, which is what stops
 * the two from bouncing an admin between them or re-triggering each other.
 *
 * Kept free of config, database, and settings imports so the ordering is
 * unit-testable on its own.
 */

/** The steps of the flow, in the order they are asked for. */
export const ONBOARDING_STEPS = {
  CREDENTIALS: 'credentials',
  DISCORD_LINK: 'discord_link',
};

/**
 * Which steps apply to an account at all, in order.
 *
 * The Discord step only applies where linking can actually be done, so a
 * deployment without the plugin connected has a one-step flow rather than a
 * step nobody can finish.
 *
 * @param {{isAdmin: boolean, discordReady: boolean, exempt: boolean}} account
 * @returns {string[]} Ordered ONBOARDING_STEPS values, empty when none apply.
 */
function applicableSteps({ isAdmin, discordReady, exempt }) {
  if (exempt || !isAdmin) return [];
  return discordReady
    ? [ONBOARDING_STEPS.CREDENTIALS, ONBOARDING_STEPS.DISCORD_LINK]
    : [ONBOARDING_STEPS.CREDENTIALS];
}

/**
 * The one step an account still owes, or null when it owes nothing.
 *
 * Credentials come first: an admin who has neither is asked for a password
 * before a Discord id, so the flow reads as one sequence rather than two
 * competing redirects. A step already satisfied is skipped rather than shown.
 *
 * @param {{isAdmin: boolean, hasPassword: boolean, hasDiscordId: boolean,
 *   discordReady: boolean, exempt?: boolean}} account
 * @returns {string|null} An ONBOARDING_STEPS value, or null when complete.
 */
export function onboardingStep({
  isAdmin,
  hasPassword,
  hasDiscordId,
  discordReady,
  exempt = false,
}) {
  const steps = applicableSteps({ isAdmin, discordReady, exempt });
  const satisfied = {
    [ONBOARDING_STEPS.CREDENTIALS]: Boolean(hasPassword),
    [ONBOARDING_STEPS.DISCORD_LINK]: Boolean(hasDiscordId),
  };
  return steps.find((step) => !satisfied[step]) ?? null;
}

/**
 * What `/api/auth/me` reports about the flow.
 *
 * The two booleans are derived from the single outstanding step, so they can
 * never both be true and the admin shell only ever has one thing to render.
 *
 * @param {{isAdmin: boolean, hasPassword: boolean, hasDiscordId: boolean,
 *   discordReady: boolean, exempt?: boolean}} account
 * @returns {{step: string|null, steps: string[], mustSetCredentials: boolean,
 *   mustLinkDiscord: boolean}} The flow's state for this account.
 */
export function onboardingState(account) {
  const step = onboardingStep(account);
  return {
    step,
    steps: applicableSteps({
      isAdmin: account.isAdmin,
      discordReady: account.discordReady,
      exempt: account.exempt ?? false,
    }),
    mustSetCredentials: step === ONBOARDING_STEPS.CREDENTIALS,
    mustLinkDiscord: step === ONBOARDING_STEPS.DISCORD_LINK,
  };
}

/**
 * Whether an account may drop its Discord identity.
 *
 * Unlinking is allowed to be undone-and-redone, and the forced step simply
 * applies again afterwards. What it may never do is leave an account with
 * neither identity, because nothing could then sign it in.
 *
 * @param {{hasPassword: boolean}} account State after the Discord id is removed.
 * @returns {boolean} True when a sign-in method would remain.
 */
export function canUnlinkDiscord({ hasPassword }) {
  return Boolean(hasPassword);
}
