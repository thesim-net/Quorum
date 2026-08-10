/**
 * Pure access policy for the Discord guild gate.
 *
 * The audience belongs to a GROUP, not to a survey: a group is either tied to
 * the connected Discord server or it is not. Not tied - the default - means
 * truly anonymous: no sign-in, no Discord call, and the role and channel lists
 * are not so much as read. Tied means two gates, the second nested in the
 * first:
 *
 *   1. the respondent signed in with Discord and is a member of the server;
 *   2. if the group also names roles or channels, they match - any one of the
 *      roles, any one of the channels, and both lists when both are populated.
 *
 * Only after both does the group admit somebody.
 *
 * A survey belongs to one or more groups, and satisfying ANY ONE of them opens
 * it. So a survey placed on Astro, Gaming and a wide-open Public group is
 * takeable by anyone, while the same survey on Astro and Gaming alone is
 * takeable by whoever qualifies under either.
 *
 * Everything that would touch Discord is injected rather than imported, so
 * every branch is unit-testable on its own - not least the one that must never
 * reach the network. It also means this file, rather than the route, is where
 * "does this cost a Discord call" is answered.
 */

/** What the gate decided. Refusals double as the code the client acts on. */
export const ACCESS = {
  OPEN: 'open',
  SIGN_IN_REQUIRED: 'discord_login_required',
  NOT_A_MEMBER: 'not_in_guild',
  NARROWED_OUT: 'not_eligible',
  UNAVAILABLE: 'discord_unavailable',
};

/**
 * Whether an audience is gated on guild membership at all.
 *
 * The single question every caller asks first: a false answer means this
 * audience behaves exactly as it did before the feature existed.
 *
 * @param {{require_guild?: boolean}} audience A group's audience rules.
 * @returns {boolean} True when the guild gate applies.
 */
export const requiresGuild = (audience) => Boolean(audience?.require_guild);

/**
 * Whether every way into a survey goes through Discord.
 *
 * Not the same question as "is any group gated". A survey with one gated group
 * and one open one is still takeable anonymously through the open one, so it
 * cannot count its respondents by Discord account - some of them will not have
 * one. Only when there is no anonymous way in at all does the survey know who
 * is answering, which is what `respondentIdentity` keys on.
 *
 * A survey with no groups is not gated by this measure; it is not takeable at
 * all, which `resolveGroupAccess` settles separately.
 *
 * @param {Array<{require_guild?: boolean}>} audiences The survey's groups.
 * @returns {boolean} True when every group requires the guild.
 */
export const everyGroupRequiresGuild = (audiences) =>
  Array.isArray(audiences) && audiences.length > 0 && audiences.every(requiresGuild);

/**
 * Turns a refusal into what the participant is actually told.
 *
 * The copy names the server when it is known, because that is the one thing
 * that tells someone how they might qualify. It never names the roles or
 * channels that would have let them in: that would hand anyone with the link a
 * map of the server. And it never distinguishes a deployment with Discord
 * switched off from one that is misconfigured or simply cannot reach Discord -
 * all three are the same "try again shortly".
 *
 * @param {string} outcome An ACCESS value other than OPEN.
 * @param {string|null} guildName The connected server's name, when known.
 * @returns {{status: number, code: string, reason: string, guild: string|null}}
 *   The refusal to send.
 */
export function refusal(outcome, guildName = null) {
  const server = guildName || 'the Discord server this survey was made for';

  const reasons = {
    [ACCESS.SIGN_IN_REQUIRED]: `This survey is for members of ${server}. Sign in with Discord to take it.`,
    [ACCESS.NOT_A_MEMBER]: `This survey is only open to members of ${server}.`,
    // Deliberately vague: saying which role or channel was missing would leak
    // the server's structure to anyone holding the link.
    [ACCESS.NARROWED_OUT]: 'Your Discord account does not have access to this survey.',
    [ACCESS.UNAVAILABLE]: 'This survey cannot be opened right now. Try again shortly.',
  };

  return {
    status: outcome === ACCESS.UNAVAILABLE ? 503 : 403,
    code: outcome,
    reason: reasons[outcome] ?? reasons[ACCESS.UNAVAILABLE],
    guild: guildName ?? null,
  };
}

/**
 * Decides whether the caller satisfies one group's audience.
 *
 * @param {object} request
 * @param {object} request.audience A group's `require_guild`, `gate_role_ids`
 *   and `gate_channel_ids`.
 * @param {boolean} request.pluginReady Whether the discord plugin is enabled
 *   with a server connected.
 * @param {string|null} request.discordId The Discord identity behind this
 *   request, from a respondent sign-in or an admin's linked account.
 * @param {object} discord Injected Discord lookups.
 * @param {(discordId: string) => Promise<{discordId: string, roleIds: string[]}|null>}
 *   discord.member Guild membership and roles in one call; null when the
 *   person is not in the server. Throwing means Discord could not be reached.
 * @param {(channelId: string, member: object) => Promise<boolean>}
 *   discord.canSeeChannel Whether the member can view one channel.
 * @returns {Promise<string>} An ACCESS value.
 */
export async function resolveAccess({ audience, pluginReady, discordId }, discord) {
  // An open group returns before `discord` is so much as read. This is the
  // promise the checkbox makes, and it is kept here rather than at each call
  // site.
  if (!requiresGuild(audience)) return ACCESS.OPEN;

  // A gated group with no working Discord behind it fails closed. It is never
  // downgraded to anonymous: its surveys were published on the understanding
  // that only the server could answer them.
  if (!pluginReady) return ACCESS.UNAVAILABLE;
  if (!discordId) return ACCESS.SIGN_IN_REQUIRED;

  // Gate 1: membership. One call returns both the answer and the roles gate 2
  // needs, so the nesting costs nothing extra.
  let member;
  try {
    member = await discord.member(discordId);
  } catch {
    return ACCESS.UNAVAILABLE;
  }
  if (!member) return ACCESS.NOT_A_MEMBER;

  // Gate 2: narrowing. Empty lists mean anyone in the server, which is the
  // whole point of gate 1 standing on its own.
  const roleIds = audience.gate_role_ids ?? [];
  const channelIds = audience.gate_channel_ids ?? [];
  if (roleIds.length === 0 && channelIds.length === 0) return ACCESS.OPEN;

  // Each populated list is a requirement in its own right, and every
  // requirement must be met. Within a list, any one entry satisfies it.
  if (roleIds.length > 0) {
    const required = new Set(roleIds);
    if (!member.roleIds.some((roleId) => required.has(roleId))) return ACCESS.NARROWED_OUT;
  }

  if (channelIds.length > 0) {
    let visible = false;
    try {
      for (const channelId of channelIds) {
        // Sequential on purpose: the first channel warms the guild metadata
        // cache the rest are answered from, so this is one fetch, not one per
        // channel, and it stops as soon as one channel matches.
        if (await discord.canSeeChannel(channelId, member)) {
          visible = true;
          break;
        }
      }
    } catch {
      return ACCESS.UNAVAILABLE;
    }
    if (!visible) return ACCESS.NARROWED_OUT;
  }

  return ACCESS.OPEN;
}

/**
 * Which refusal is reported when no group admits the caller.
 *
 * Ordered by how much the person can do about it. Being asked to sign in comes
 * first, because it is the one refusal that may turn into access. An outage
 * comes next, so a Discord hiccup reads as "try again shortly" rather than as a
 * verdict on the account. Only then the two settled refusals, joining the
 * server before qualifying within it, which is the order somebody would act in.
 */
const REFUSAL_ORDER = [
  ACCESS.SIGN_IN_REQUIRED,
  ACCESS.UNAVAILABLE,
  ACCESS.NOT_A_MEMBER,
  ACCESS.NARROWED_OUT,
];

/**
 * Decides whether the caller may open a survey, across all of its groups.
 *
 * Satisfying any one group is enough. Open groups are evaluated first so a
 * survey that anybody can take costs no Discord call at all, however many gated
 * groups it also belongs to, and the first group that admits the caller ends
 * the search.
 *
 * A survey with no groups admits nobody. The API keeps that from happening, and
 * this fails closed rather than treating "no rules" as "no restrictions".
 *
 * @param {object} request
 * @param {Array<object>} request.audiences The audience rules of every group
 *   the survey belongs to.
 * @param {boolean} request.pluginReady Whether the discord plugin is enabled
 *   with a server connected.
 * @param {string|null} request.discordId The Discord identity behind this
 *   request.
 * @param {object} discord Injected Discord lookups, as `resolveAccess` takes.
 * @returns {Promise<string>} An ACCESS value.
 */
export async function resolveGroupAccess({ audiences, pluginReady, discordId }, discord) {
  const groups = Array.isArray(audiences) ? audiences : [];
  if (groups.length === 0) return ACCESS.NARROWED_OUT;

  const ordered = [...groups].sort((a, b) => Number(requiresGuild(a)) - Number(requiresGuild(b)));

  const outcomes = new Set();
  for (const audience of ordered) {
    const outcome = await resolveAccess({ audience, pluginReady, discordId }, discord);
    if (outcome === ACCESS.OPEN) return ACCESS.OPEN;
    outcomes.add(outcome);
  }

  return REFUSAL_ORDER.find((outcome) => outcomes.has(outcome)) ?? ACCESS.NARROWED_OUT;
}
