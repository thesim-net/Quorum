import * as discord from './discord.js';
import { canViewChannel } from './permissions.js';

/**
 * Survey access gates.
 *
 * Guild metadata (roles, channels, overwrites) changes rarely but is needed on
 * every gated survey load, so it is cached in-process behind a short TTL.
 */

const CACHE_TTL_MS = 60_000;
let cache = null;

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

/** Discards cached guild metadata, forcing the next read to hit Discord. */
export function invalidateGuildCache() {
  cache = null;
}

/**
 * Decides whether a member may open a survey.
 *
 * Guild membership is a precondition for every gate; beyond that a survey may
 * additionally require specific roles, or the ability to view a channel.
 *
 * @param {object} survey Survey row with `gate`, `gate_role_ids`, `gate_channel_id`.
 * @param {{discordId: string, roleIds: string[]}} member The signed-in member.
 * @returns {Promise<{allowed: boolean, reason?: string}>} Verdict, with a
 *   participant-safe reason when access is refused.
 */
export async function evaluateGate(survey, member) {
  const roleIds = survey.gate_role_ids ?? [];
  const channelIds = survey.gate_channel_ids ?? [];

  // No requirements means anyone in the server.
  if (roleIds.length === 0 && channelIds.length === 0) return { allowed: true };

  // Each populated list is a requirement in its own right, and every
  // requirement must be met. Within a list, any one entry satisfies it.
  if (roleIds.length > 0) {
    const required = new Set(roleIds);
    if (!member.roleIds.some((roleId) => required.has(roleId))) {
      return { allowed: false, reason: 'This survey is limited to certain roles in the server.' };
    }
  }

  if (channelIds.length > 0) {
    const meta = await guildMetadata();

    const visible = channelIds.some((channelId) => {
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
    });

    if (!visible) {
      return {
        allowed: false,
        reason: 'This survey is limited to members of specific channels.',
      };
    }
  }

  return { allowed: true };
}
