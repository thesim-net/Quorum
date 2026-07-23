import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';
import { query } from '../db/pool.js';
import { DecryptError, open, seal } from './secretbox.js';

/**
 * Runtime Discord configuration.
 *
 * Values come from the setup wizard and live encrypted in the database, so a
 * redeploy does not need credentials in its environment. An environment that
 * does supply a complete set still wins, which keeps declarative deployments
 * working and gives an escape hatch if the stored copy becomes unreadable.
 */

let cache = null;

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
 * Loads settings into the in-process cache.
 *
 * Called at boot and after every save, so `current()` can stay synchronous for
 * the request path.
 *
 * @returns {Promise<object>} The active settings.
 */
export async function loadSettings() {
  // Plugin enablement lives in app_settings regardless of how Discord itself
  // is configured, so the row is read up front.
  const { rows } = await query('SELECT * FROM app_settings WHERE id = true');
  const row = rows[0];
  const plugins = row?.plugins ?? {};

  if (envIsComplete()) {
    cache = {
      source: 'environment',
      configured: true,
      clientId: config.discord.clientId,
      clientSecret: config.discord.clientSecret,
      botToken: config.discord.botToken,
      guildId: config.discord.guildId,
      guildName: null,
      adminRoleIds: config.adminRoleIds,
      adminChannelIds: [],
      plugins,
      readOnly: true,
      error: null,
    };
    return cache;
  }

  if (!row?.discord_client_id) {
    cache = {
      source: null,
      configured: false,
      adminRoleIds: config.adminRoleIds,
      adminChannelIds: [],
      plugins,
      readOnly: false,
      error: null,
    };
    return cache;
  }

  try {
    cache = {
      source: 'database',
      configured: true,
      clientId: row.discord_client_id,
      clientSecret: open(row.discord_client_secret_enc),
      botToken: open(row.discord_bot_token_enc),
      guildId: row.discord_guild_id,
      guildName: row.guild_name,
      adminRoleIds: [...config.adminRoleIds, ...row.admin_role_ids],
      adminChannelIds: row.admin_channel_ids ?? [],
      plugins,
      configuredAt: row.configured_at,
      readOnly: false,
      error: null,
    };
  } catch (error) {
    if (!(error instanceof DecryptError)) throw error;
    // SESSION_SECRET changed. Report it rather than crashing, so the operator
    // can re-run setup instead of being locked out with a stack trace.
    console.error('Stored Discord credentials are unreadable; setup must be run again.');
    cache = {
      source: 'database',
      configured: false,
      adminRoleIds: config.adminRoleIds,
      adminChannelIds: [],
      plugins,
      readOnly: false,
      error: 'unreadable',
    };
  }

  return cache;
}

/**
 * Persists the global plugin enablement map and refreshes the cache.
 *
 * A row is created if setup has not run yet, so plugins can be managed
 * independently of Discord configuration.
 *
 * @param {object} plugins A { key: boolean } map.
 * @returns {Promise<object>} The reloaded settings.
 */
export async function savePlugins(plugins) {
  await query(
    `INSERT INTO app_settings (id, plugins) VALUES (true, $1)
     ON CONFLICT (id) DO UPDATE SET plugins = $1, updated_at = now()`,
    [plugins],
  );
  return loadSettings();
}

/**
 * Reads the cached settings.
 *
 * @returns {object} Active settings; `configured` is false before setup.
 */
export function current() {
  if (!cache) throw new Error('Settings accessed before loadSettings()');
  return cache;
}

/**
 * Returns the Discord credentials, or throws if setup has not been completed.
 *
 * @returns {{clientId: string, clientSecret: string, botToken: string, guildId: string}}
 * @throws {Error} When Discord has not been configured.
 */
export function requireDiscord() {
  const settings = current();
  if (!settings.configured) {
    throw new Error('Discord is not configured yet. Complete setup first.');
  }
  return settings;
}

/**
 * Persists Discord credentials from the setup wizard.
 *
 * @param {object} values Verified credentials plus the resolved guild name.
 * @param {string|null} actorId User id of the admin re-running setup, if any.
 * @returns {Promise<object>} The reloaded settings.
 */
export async function saveDiscordSettings(values, actorId = null) {
  await query(
    `INSERT INTO app_settings (id, discord_client_id, discord_client_secret_enc,
                               discord_bot_token_enc, discord_guild_id, guild_name,
                               admin_role_ids, admin_channel_ids, configured_at,
                               configured_by, updated_at)
          VALUES (true, $1, $2, $3, $4, $5, $6, $7, now(), $8, now())
     ON CONFLICT (id) DO UPDATE
          SET discord_client_id = EXCLUDED.discord_client_id,
              discord_client_secret_enc = EXCLUDED.discord_client_secret_enc,
              discord_bot_token_enc = EXCLUDED.discord_bot_token_enc,
              discord_guild_id = EXCLUDED.discord_guild_id,
              guild_name = EXCLUDED.guild_name,
              admin_role_ids = EXCLUDED.admin_role_ids,
              admin_channel_ids = EXCLUDED.admin_channel_ids,
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
      actorId,
    ],
  );

  return loadSettings();
}

// ---------------------------------------------------------------------------
// Setup tokens
// ---------------------------------------------------------------------------

/**
 * Hashes a setup token for storage.
 *
 * @param {string} token Raw token as shown to the operator.
 * @returns {Buffer} SHA-256 digest.
 */
const hashToken = (token) => createHash('sha256').update(token).digest();

/**
 * Issues a setup token, printing it where the operator can find it.
 *
 * Existing unconsumed tokens are expired first, so only the most recently
 * printed token is ever valid.
 *
 * @param {number} ttlMinutes How long the token remains usable.
 * @returns {Promise<string>} The raw token.
 */
export async function issueSetupToken(ttlMinutes = 60) {
  const token = randomBytes(24).toString('base64url');

  await query('UPDATE setup_tokens SET expires_at = now() WHERE consumed_at IS NULL');
  await query(
    `INSERT INTO setup_tokens (token_hash, expires_at)
     VALUES ($1, now() + ($2 || ' minutes')::interval)`,
    [hashToken(token), String(ttlMinutes)],
  );

  return token;
}

/**
 * Validates a setup token.
 *
 * @param {string} token Raw token supplied by the operator.
 * @returns {Promise<object|null>} The token row, or null when invalid.
 */
export async function verifySetupToken(token) {
  if (!token) return null;

  const { rows } = await query(
    'SELECT * FROM setup_tokens WHERE expires_at > now() AND consumed_at IS NULL',
  );

  const supplied = hashToken(String(token));
  for (const row of rows) {
    const stored = Buffer.from(row.token_hash);
    if (stored.length === supplied.length && timingSafeEqual(stored, supplied)) return row;
  }
  return null;
}

/**
 * Marks a token as having saved credentials and awaiting its admin claim.
 *
 * @param {string} tokenId Token row id.
 * @returns {Promise<void>}
 */
export async function markAwaitingAdminClaim(tokenId) {
  await query('UPDATE setup_tokens SET awaiting_admin_claim = true WHERE id = $1', [tokenId]);
}

/**
 * Consumes a token that is waiting to mint the first admin.
 *
 * @param {string} tokenId Token row id.
 * @returns {Promise<boolean>} True when this call claimed the token.
 */
export async function claimAdminToken(tokenId) {
  const { rowCount } = await query(
    `UPDATE setup_tokens SET consumed_at = now()
      WHERE id = $1 AND consumed_at IS NULL AND awaiting_admin_claim = true
        AND expires_at > now()`,
    [tokenId],
  );
  return rowCount > 0;
}

/**
 * Issues a setup token at boot when there is no usable configuration.
 *
 * @returns {Promise<void>}
 */
export async function ensureSetupTokenIfNeeded() {
  const settings = current();
  if (settings.configured) return;

  const token = await issueSetupToken();
  const url = `${config.publicUrl}/setup?token=${token}`;
  console.log(
    `\n${'='.repeat(72)}\n` +
      'Quorum is not configured yet. Open this URL to connect your Discord server:\n\n' +
      `  ${url}\n\n` +
      'This link is valid for one hour. Restart the container to issue a new one.\n' +
      `${'='.repeat(72)}\n`,
  );
}
