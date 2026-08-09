import { config } from '../../config.js';
import { query } from '../../db/pool.js';
import { current } from '../../lib/settings.js';
import { TIERS } from '../../lib/permissionSet.js';
import * as discord from './discord.js';
import { guildMetadata } from './gate.js';
import { canViewChannel } from './permissions.js';

/**
 * Session hooks for Discord-backed accounts.
 *
 * Core session loading calls into here only while the plugin is enabled and a
 * server is connected; local accounts and disabled deployments never touch
 * Discord.
 */

/**
 * Re-reads a member's roles from Discord and updates the session snapshot.
 *
 * Also removes the session outright if the member has left the guild, so access
 * ends when membership does rather than at session expiry.
 *
 * @param {object} session Session row.
 * @param {string} discordId
 * @returns {Promise<string[]|null>} Current roles, or null when the member is
 *   no longer in the guild.
 */
export async function refreshSessionRoles(session, discordId) {
  const member = await discord.guildMember(discordId);
  if (!member) {
    await query('DELETE FROM sessions WHERE id = $1', [session.id]);
    return null;
  }

  await query(
    'UPDATE sessions SET role_ids = $2, roles_synced_at = now() WHERE id = $1',
    [session.id, member.roles],
  );
  return member.roles;
}

/**
 * Whether a member's roles let them see any channel that grants admin access.
 *
 * @param {string[]} roleIds Roles held by the member.
 * @param {string} discordId
 * @returns {Promise<boolean>} True when one of the configured channels is visible.
 */
async function grantedByChannel(roleIds, discordId) {
  const channelIds = current().discord.adminChannelIds ?? [];
  if (channelIds.length === 0) return false;

  try {
    const meta = await guildMetadata();
    return channelIds.some((channelId) => {
      const channel = meta.channelsById.get(channelId);
      if (!channel) return false;
      return canViewChannel({
        guild: meta.guild,
        channel,
        parentChannel: channel.parent_id ? meta.channelsById.get(channel.parent_id) ?? null : null,
        memberRoleIds: roleIds,
        memberId: discordId,
        rolePermissions: meta.rolePermissions,
      });
    });
  } catch {
    // A Discord failure must not silently grant access.
    return false;
  }
}

/**
 * The tier a member's Discord standing contributes on top of their stored one.
 *
 * @param {{discord_id: string, tier: string}} session Session row.
 * @param {string[]} roleIds Roles the member currently holds.
 * @returns {Promise<string>} A TIERS value.
 */
export async function discordTier(session, roleIds) {
  // Bootstrap ids are super admins regardless of roles, so the first
  // deployment has a way in before any grant exists.
  if (config.bootstrapAdminIds.includes(session.discord_id)) return TIERS.SUPER;

  // Role and channel derived access is deliberately capped at `admin`. An
  // unrestricted account should never appear because someone joined a channel.
  const adminRoleIds = current().discord.adminRoleIds ?? [];
  if (roleIds.some((roleId) => adminRoleIds.includes(roleId))) return TIERS.ADMIN;

  // Only consult Discord about channel-granted access when the stored tier
  // would not already cover it.
  if (session.tier !== TIERS.SUPER && (await grantedByChannel(roleIds, session.discord_id))) {
    return TIERS.ADMIN;
  }

  return TIERS.NONE;
}

/**
 * The configured admin-access sources, resolved to names for the admin list.
 *
 * @returns {Promise<{roles: Array<{id: string, name: string}>,
 *   channels: Array<{id: string, name: string}>, bootstrapIds: string[]}>}
 */
export async function adminDirectory() {
  const settings = current().discord;

  let meta = null;
  try {
    meta = await guildMetadata();
  } catch {
    meta = null;
  }

  return {
    roles: (settings.adminRoleIds ?? []).map((roleId) => ({
      id: roleId,
      name: meta?.roles.find((role) => role.id === roleId)?.name ?? 'Unknown role',
    })),
    channels: (settings.adminChannelIds ?? []).map((channelId) => ({
      id: channelId,
      name: meta?.channelsById.get(channelId)?.name ?? 'Unknown channel',
    })),
    bootstrapIds: config.bootstrapAdminIds,
  };
}

/**
 * Whether BOOTSTRAP_ADMIN_IDS provides a super admin outside the users table.
 *
 * Used by the lockout checks: revoking the last stored super admin is safe
 * when a bootstrap id can still get in.
 *
 * @returns {boolean} True when a bootstrap super admin exists.
 */
export function hasBootstrapSupers() {
  return config.bootstrapAdminIds.length > 0;
}
