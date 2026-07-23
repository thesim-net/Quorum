/**
 * Discord permission resolution.
 *
 * Discord exposes no "who is in a channel" endpoint - channel membership is
 * derived from a member's roles evaluated against the channel's permission
 * overwrites. This module reproduces that calculation so a survey can be gated
 * on "can view #channel".
 */

const ADMINISTRATOR = 1n << 3n;
const VIEW_CHANNEL = 1n << 10n;
const ALL_PERMISSIONS = (1n << 64n) - 1n;

// Threads inherit permissions from the channel they live in rather than
// carrying overwrites of their own.
const THREAD_TYPES = new Set([10, 11, 12]);

/**
 * Union of the permissions granted by a member's roles at the guild level.
 *
 * @param {{ id: string, ownerId: string }} guild
 * @param {string[]} memberRoleIds Role snowflakes held by the member.
 * @param {Map<string, bigint>} rolePermissions Role snowflake -> permission bits.
 * @param {string} memberId
 * @returns {bigint} Guild-wide permission bits, before channel overwrites.
 */
export function computeBasePermissions(guild, memberRoleIds, rolePermissions, memberId) {
  if (guild.ownerId === memberId) return ALL_PERMISSIONS;

  // Every member implicitly holds @everyone, whose role id equals the guild id.
  let permissions = rolePermissions.get(guild.id) ?? 0n;
  for (const roleId of memberRoleIds) {
    permissions |= rolePermissions.get(roleId) ?? 0n;
  }

  return permissions & ADMINISTRATOR ? ALL_PERMISSIONS : permissions;
}

/**
 * Applies a channel's overwrites to a member's guild-level permissions.
 *
 * Overwrites resolve in a fixed order - @everyone, then the union of the
 * member's role overwrites, then any member-specific overwrite - with denies
 * applied before allows at each step.
 *
 * @param {bigint} basePermissions Result of computeBasePermissions.
 * @param {string} guildId
 * @param {{ permission_overwrites?: Array<{id: string, type: number, allow: string, deny: string}> }} channel
 * @param {string[]} memberRoleIds
 * @param {string} memberId
 * @returns {bigint} Effective permission bits inside the channel.
 */
export function computeOverwrites(basePermissions, guildId, channel, memberRoleIds, memberId) {
  // An administrator cannot be denied by an overwrite.
  if (basePermissions & ADMINISTRATOR) return ALL_PERMISSIONS;

  let permissions = basePermissions;
  const overwrites = channel.permission_overwrites ?? [];

  const everyone = overwrites.find((o) => o.id === guildId);
  if (everyone) {
    permissions &= ~BigInt(everyone.deny);
    permissions |= BigInt(everyone.allow);
  }

  let roleAllow = 0n;
  let roleDeny = 0n;
  for (const overwrite of overwrites) {
    if (overwrite.type !== 0 || overwrite.id === guildId) continue;
    if (!memberRoleIds.includes(overwrite.id)) continue;
    roleAllow |= BigInt(overwrite.allow);
    roleDeny |= BigInt(overwrite.deny);
  }
  permissions &= ~roleDeny;
  permissions |= roleAllow;

  const member = overwrites.find((o) => o.type === 1 && o.id === memberId);
  if (member) {
    permissions &= ~BigInt(member.deny);
    permissions |= BigInt(member.allow);
  }

  return permissions;
}

/**
 * Whether a member can see a given channel.
 *
 * @param {object} params
 * @param {{ id: string, ownerId: string }} params.guild
 * @param {object} params.channel Channel object from the Discord API.
 * @param {object|null} params.parentChannel Parent channel, required when
 *   `channel` is a thread since threads carry no overwrites of their own.
 * @param {string[]} params.memberRoleIds
 * @param {string} params.memberId
 * @param {Map<string, bigint>} params.rolePermissions
 * @returns {boolean} True when the member holds VIEW_CHANNEL on the channel.
 */
export function canViewChannel({
  guild,
  channel,
  parentChannel = null,
  memberRoleIds,
  memberId,
  rolePermissions,
}) {
  const effectiveChannel = THREAD_TYPES.has(channel.type) ? parentChannel ?? channel : channel;

  const base = computeBasePermissions(guild, memberRoleIds, rolePermissions, memberId);
  const permissions = computeOverwrites(base, guild.id, effectiveChannel, memberRoleIds, memberId);

  return (permissions & VIEW_CHANNEL) === VIEW_CHANNEL;
}

export const PERMISSION_BITS = { ADMINISTRATOR, VIEW_CHANNEL };
