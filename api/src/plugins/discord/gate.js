import * as discord from './discord.js';
import { canViewChannel } from './permissions.js';

/**
 * The Discord half of survey gating: the calls, and the caches over them.
 *
 * The decisions themselves live in `guildGate.js`, which is pure. Everything
 * here exists to answer two questions cheaply - is this person in the server,
 * and can they see this channel - without a gated survey costing a request to
 * Discord per survey or per respondent.
 *
 * Guild metadata (roles, channels, overwrites) changes rarely but is needed by
 * every channel check, and membership changes rarely but is needed by every
 * gated load, so both sit behind the same short TTL.
 */

const CACHE_TTL_MS = 60_000;

// A ceiling on the membership cache. It is a cache, not a session store, so
// dropping it wholesale is always safe - the next request simply asks Discord.
const MEMBER_CACHE_MAX = 1000;

let cache = null;
const memberCache = new Map();

/**
 * Loads guild, roles and channels, refreshing the cache when stale.
 *
 * @param {boolean} force Bypass the TTL and re-fetch immediately.
 * @returns {Promise<{guild: object, roles: object[], channels: object[],
 *   rolePermissions: Map<string, bigint>, channelsById: Map<string, object>}>}
 *   Guild metadata with lookup maps prepared for permission maths.
 */
export async function guildMetadata(force = false) {
  if (!force && cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.value;

  const [guild, roles, channels] = await Promise.all([
    discord.guild(),
    discord.guildRoles(),
    discord.guildChannels(),
  ]);

  const value = {
    guild: { id: guild.id, ownerId: guild.owner_id, name: guild.name },
    roles,
    channels,
    rolePermissions: new Map(roles.map((role) => [role.id, BigInt(role.permissions)])),
    channelsById: new Map(channels.map((channel) => [channel.id, channel])),
  };

  cache = { at: Date.now(), value };
  return value;
}

/** Discards cached guild metadata and membership, forcing the next read to hit Discord. */
export function invalidateGuildCache() {
  cache = null;
  memberCache.clear();
}

/**
 * The connected server's name, but only if it is already in hand.
 *
 * Participant-facing copy names the server, and naming it must never cost a
 * request its own round trip to Discord - an unknown name simply falls back to
 * generic wording.
 *
 * @returns {string|null} The guild name, or null when nothing is cached.
 */
export const cachedGuildName = () => cache?.value.guild.name ?? null;

/**
 * Whether someone is in the guild, and with which roles.
 *
 * One call answers both halves of the gate: the member object carries the
 * `roles` array the role narrowing is evaluated against. A 404 is a verdict,
 * not a failure, so it comes back as null; anything else throws, and the caller
 * fails closed rather than admitting someone during an outage.
 *
 * Cached per member for the same short TTL as the guild metadata, so listing
 * ten gated surveys costs one call rather than ten, while someone who leaves
 * the server loses access within the minute.
 *
 * The member's name is carried alongside their roles because the same response
 * already contains it. A survey that collects identity records it against the
 * response; the gate itself never reads it, and nothing here is persisted.
 *
 * @param {string} discordId
 * @param {boolean} force Bypass the TTL.
 * @returns {Promise<{discordId: string, roleIds: string[], username: string|null,
 *   displayName: string|null}|null>} The member, or null when they are not in
 *   the server.
 */
export async function guildMembership(discordId, force = false) {
  const hit = memberCache.get(discordId);
  if (!force && hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;

  const member = await discord.guildMember(discordId);
  const value = member
    ? {
        discordId,
        roleIds: member.roles ?? [],
        username: member.user?.username ?? null,
        // The server nickname is what other members actually see, so it wins;
        // the global display name is the next best, and a bare handle is the
        // floor.
        displayName: member.nick ?? member.user?.global_name ?? null,
      }
    : null;

  if (memberCache.size >= MEMBER_CACHE_MAX) memberCache.clear();
  memberCache.set(discordId, { at: Date.now(), value });
  return value;
}

/**
 * Whether a member can view one channel.
 *
 * Discord exposes no "who is in a channel" endpoint, so this is resolved from
 * the member's roles against the channel's overwrites, off cached metadata.
 *
 * @param {string} channelId
 * @param {{discordId: string, roleIds: string[]}} member
 * @returns {Promise<boolean>} True when the channel is visible to them.
 */
export async function channelVisibleTo(channelId, member) {
  const meta = await guildMetadata();
  const channel = meta.channelsById.get(channelId);
  if (!channel) return false;

  return canViewChannel({
    guild: meta.guild,
    channel,
    parentChannel: channel.parent_id ? meta.channelsById.get(channel.parent_id) ?? null : null,
    memberRoleIds: member.roleIds,
    memberId: member.discordId,
    rolePermissions: meta.rolePermissions,
  });
}
