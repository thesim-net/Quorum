import { config } from '../../config.js';
import { query } from '../../db/pool.js';
import { DecryptError, open, seal } from '../../lib/secretbox.js';
import { current, loadSettings } from '../../lib/settings.js';

/**
 * Discord credential handling.
 *
 * Values come from the plugin's settings page and live encrypted in the
 * database, so a redeploy does not need credentials in its environment. An
 * environment that does supply a complete set still wins, which keeps
 * declarative deployments working and gives an escape hatch if the stored copy
 * becomes unreadable.
 */

/**
 * Whether the environment carries a complete Discord configuration.
 *
 * @returns {boolean} True when every required value is present.
 */
function envIsComplete() {
  const { clientId, clientSecret, botToken, guildId } = config.discord;
  return Boolean(clientId && clientSecret && botToken && guildId);
}

/**
 * Builds the Discord slice of the settings cache from the app_settings row.
 *
 * Called by the core settings loader; pure apart from reading the environment
 * and decrypting stored secrets.
 *
 * @param {object|null} row The app_settings row, or null before any save.
 * @returns {object} The Discord settings slice; `configured` is false until a
 *   server is connected.
 */
export function deriveDiscordSettings(row) {
  // Which group role- and channel-derived admins land in is never pinned to the
  // environment: it names a row in this deployment's own groups table, so it is
  // read from the settings row whatever the credentials come from. Unset means
  // those accounts get no access at all, which is the safe reading of "nobody
  // has chosen a group for them".
  const adminGroupId = row?.discord_admin_group_id ?? null;

  if (envIsComplete()) {
    return {
      source: 'environment',
      configured: true,
      clientId: config.discord.clientId,
      clientSecret: config.discord.clientSecret,
      botToken: config.discord.botToken,
      guildId: config.discord.guildId,
      guildName: null,
      adminRoleIds: config.adminRoleIds,
      adminChannelIds: [],
      adminGroupId,
      readOnly: true,
      error: null,
    };
  }

  if (!row?.discord_client_id) {
    return {
      source: null,
      configured: false,
      adminRoleIds: config.adminRoleIds,
      adminChannelIds: [],
      adminGroupId,
      readOnly: false,
      error: null,
    };
  }

  try {
    return {
      source: 'database',
      configured: true,
      clientId: row.discord_client_id,
      clientSecret: open(row.discord_client_secret_enc),
      botToken: open(row.discord_bot_token_enc),
      guildId: row.discord_guild_id,
      guildName: row.guild_name,
      adminRoleIds: [...config.adminRoleIds, ...row.admin_role_ids],
      adminChannelIds: row.admin_channel_ids ?? [],
      adminGroupId,
      configuredAt: row.configured_at,
      readOnly: false,
      error: null,
    };
  } catch (error) {
    if (!(error instanceof DecryptError)) throw error;
    // SESSION_SECRET changed. Report it rather than crashing, so the operator
    // can reconnect the server instead of being locked out with a stack trace.
    console.error('Stored Discord credentials are unreadable; reconnect the server.');
    return {
      source: 'database',
      configured: false,
      adminRoleIds: config.adminRoleIds,
      adminChannelIds: [],
      adminGroupId,
      readOnly: false,
      error: 'unreadable',
    };
  }
}

/**
 * Returns the Discord credentials, or throws if no server is connected.
 *
 * @returns {{clientId: string, clientSecret: string, botToken: string, guildId: string}}
 * @throws {Error} When Discord has not been configured.
 */
export function requireDiscord() {
  const settings = current().discord;
  if (!settings.configured) {
    throw new Error('Discord is not configured yet. Connect a server in the plugin settings.');
  }
  return settings;
}

/**
 * Persists Discord credentials from the connection wizard.
 *
 * @param {object} values Verified credentials plus the resolved guild name.
 * @param {string|null} actorId User id of the admin saving them, if any.
 * @returns {Promise<object>} The reloaded settings.
 */
export async function saveDiscordSettings(values, actorId = null) {
  await query(
    `INSERT INTO app_settings (id, discord_client_id, discord_client_secret_enc,
                               discord_bot_token_enc, discord_guild_id, guild_name,
                               admin_role_ids, admin_channel_ids, discord_admin_group_id,
                               configured_at, configured_by, updated_at)
          VALUES (true, $1, $2, $3, $4, $5, $6, $7, $8, now(), $9, now())
     ON CONFLICT (id) DO UPDATE
          SET discord_client_id = EXCLUDED.discord_client_id,
              discord_client_secret_enc = EXCLUDED.discord_client_secret_enc,
              discord_bot_token_enc = EXCLUDED.discord_bot_token_enc,
              discord_guild_id = EXCLUDED.discord_guild_id,
              guild_name = EXCLUDED.guild_name,
              admin_role_ids = EXCLUDED.admin_role_ids,
              admin_channel_ids = EXCLUDED.admin_channel_ids,
              discord_admin_group_id = EXCLUDED.discord_admin_group_id,
              configured_at = now(),
              configured_by = COALESCE(EXCLUDED.configured_by, app_settings.configured_by),
              updated_at = now()`,
    [
      values.clientId,
      seal(values.clientSecret),
      seal(values.botToken),
      values.guildId,
      values.guildName ?? null,
      values.adminRoleIds ?? [],
      values.adminChannelIds ?? [],
      values.adminGroupId ?? null,
      actorId,
    ],
  );

  return loadSettings();
}

/**
 * Clears the stored Discord configuration.
 *
 * Only the Discord columns are touched: plugin enablement and sign-in method
 * toggles live in the same row and must survive a disconnect.
 *
 * @returns {Promise<object>} The reloaded settings.
 */
export async function resetDiscordSettings() {
  await query(
    `UPDATE app_settings
        SET discord_client_id = NULL,
            discord_client_secret_enc = NULL,
            discord_bot_token_enc = NULL,
            discord_guild_id = NULL,
            guild_name = NULL,
            admin_role_ids = '{}',
            admin_channel_ids = '{}',
            -- The landing group only meant anything alongside those two lists.
            discord_admin_group_id = NULL,
            configured_at = NULL,
            updated_at = now()
      WHERE id = true`,
  );
  return loadSettings();
}
