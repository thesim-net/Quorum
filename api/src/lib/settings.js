import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';
import { query } from '../db/pool.js';
import { PLUGINS, isPluginEnabled } from './plugins.js';
import { deriveDiscordSettings } from '../plugins/discord/settings.js';

/**
 * Runtime configuration cache.
 *
 * Everything a request path needs synchronously lives here: plugin enablement,
 * which sign-in methods are offered, and the Discord plugin's credential slice
 * (derived by that plugin, stored here so `current()` stays one lookup).
 */

let cache = null;

/**
 * Loads settings into the in-process cache.
 *
 * Called at boot and after every save, so `current()` can stay synchronous for
 * the request path.
 *
 * @returns {Promise<object>} The active settings.
 */
export async function loadSettings() {
  const { rows } = await query('SELECT * FROM app_settings WHERE id = true');
  const row = rows[0] ?? null;

  const discord = deriveDiscordSettings(row);

  const plugins = { ...(row?.plugins ?? {}) };
  // Environment-pinned Discord credentials imply the plugin: without this, an
  // env-configured deployment would need a database row before Discord sign-in
  // or gating could work at all.
  if (discord.source === 'environment') plugins[PLUGINS.DISCORD] = true;

  // Local sign-in defaults on; Discord defaults to whether it is configured,
  // which keeps pre-toggle deployments signing in the way they always did.
  const authMethods = {
    local: row?.auth_methods ? Boolean(row.auth_methods.local) : true,
    discord: row?.auth_methods ? Boolean(row.auth_methods.discord) : discord.configured,
  };

  // Accessibility default for the animated wordmark, and the deployment-wide
  // two-factor policy. Both default to their pre-feature behaviour when the
  // column is absent on an older row.
  const asciiAnimationDefault = row?.ascii_animation_default ?? true;
  const require2faAllAdmins = Boolean(row?.require_2fa_all_admins);

  // Downloading a new version and restarting into it are separate switches,
  // because they cost very different things. Both default off on a row that
  // predates them: acquiring an unattended restart by applying a migration is
  // the one outcome this feature must not have.
  const autoUpdate = {
    enabled: Boolean(row?.auto_update_enabled),
    intervalSeconds: row?.auto_update_interval_seconds ?? null,
    restart: Boolean(row?.auto_update_restart),
    lastRunAt: row?.auto_update_last_run_at ?? null,
    stagedVersion: row?.auto_update_staged_version ?? null,
    lastError: row?.auto_update_last_error ?? null,
  };

  cache = {
    plugins,
    authMethods,
    discord,
    asciiAnimationDefault,
    require2faAllAdmins,
    autoUpdate,
  };
  return cache;
}

/**
 * Reads the cached settings.
 *
 * @returns {{plugins: object, authMethods: object, discord: object}} Active settings.
 */
export function current() {
  if (!cache) throw new Error('Settings accessed before loadSettings()');
  return cache;
}

/**
 * Resolves which sign-in methods actually work right now.
 *
 * The Discord toggle only counts while the discord plugin is enabled and a
 * server is connected; a toggle with nothing behind it is reported off.
 *
 * @returns {{local: boolean, discord: boolean}} Usable methods.
 */
export function effectiveAuthMethods() {
  const settings = current();
  return {
    local: Boolean(settings.authMethods.local),
    discord:
      Boolean(settings.authMethods.discord) &&
      isPluginEnabled(settings.plugins, PLUGINS.DISCORD) &&
      settings.discord.configured,
  };
}

/**
 * Persists the global plugin enablement map and refreshes the cache.
 *
 * A row is created if none exists yet, so plugins can be managed before
 * anything else has been configured.
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
 * Persists the sign-in method toggles and refreshes the cache.
 *
 * @param {{local: boolean, discord: boolean}} methods
 * @returns {Promise<object>} The reloaded settings.
 */
export async function saveAuthMethods(methods) {
  await query(
    `INSERT INTO app_settings (id, auth_methods) VALUES (true, $1)
     ON CONFLICT (id) DO UPDATE SET auth_methods = $1, updated_at = now()`,
    [methods],
  );
  return loadSettings();
}

/**
 * Persists the default for the animated wordmark and refreshes the cache.
 *
 * @param {boolean} enabled Whether the wordmark animates by default.
 * @returns {Promise<object>} The reloaded settings.
 */
export async function saveAsciiAnimationDefault(enabled) {
  await query(
    `INSERT INTO app_settings (id, ascii_animation_default) VALUES (true, $1)
     ON CONFLICT (id) DO UPDATE SET ascii_animation_default = $1, updated_at = now()`,
    [enabled],
  );
  return loadSettings();
}

/**
 * Persists the deployment-wide two-factor policy and refreshes the cache.
 *
 * @param {boolean} required Whether every admin must use 2FA.
 * @returns {Promise<object>} The reloaded settings.
 */
export async function saveRequire2faAllAdmins(required) {
  await query(
    `INSERT INTO app_settings (id, require_2fa_all_admins) VALUES (true, $1)
     ON CONFLICT (id) DO UPDATE SET require_2fa_all_admins = $1, updated_at = now()`,
    [required],
  );
  return loadSettings();
}

/**
 * Persists the automatic update schedule and refreshes the cache.
 *
 * The interval is taken already validated rather than validated here, so that
 * one rule - the twice-a-day floor in `lib/autoUpdate.js` - answers for both
 * the settings form and any direct API call.
 *
 * Turning the schedule off clears the interval with it. Keeping the last one
 * would make re-enabling silently resume a cadence nobody was looking at.
 *
 * @param {{enabled: boolean, intervalSeconds: number|null, restart: boolean}} schedule
 * @returns {Promise<object>} The reloaded settings.
 */
export async function saveAutoUpdate({ enabled, intervalSeconds, restart }) {
  await query(
    `INSERT INTO app_settings (id, auto_update_enabled, auto_update_interval_seconds,
                               auto_update_restart)
          VALUES (true, $1, $2, $3)
     ON CONFLICT (id) DO UPDATE
          SET auto_update_enabled = $1,
              auto_update_interval_seconds = $2,
              auto_update_restart = $3,
              updated_at = now()`,
    [Boolean(enabled), enabled ? intervalSeconds : null, Boolean(enabled) && Boolean(restart)],
  );
  return loadSettings();
}

/**
 * Whether the deployment has a way for an administrator to sign in.
 *
 * Setup is complete once a super admin account exists. An environment-pinned
 * Discord deployment with BOOTSTRAP_ADMIN_IDS also counts: its first super
 * admin arrives by signing in with Discord rather than through the setup form.
 *
 * @returns {Promise<boolean>} True when no bootstrap is needed.
 */
export async function isBootstrapped() {
  if (config.devAuthBypass) return true;

  const { rows } = await query(
    `SELECT EXISTS (SELECT 1 FROM users WHERE tier = 'super_admin') AS present`,
  );
  if (rows[0].present) return true;

  return effectiveAuthMethods().discord && config.bootstrapAdminIds.length > 0;
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
 * Consumes a setup token so it can mint the first admin exactly once.
 *
 * @param {string} tokenId Token row id.
 * @returns {Promise<boolean>} True when this call claimed the token.
 */
export async function consumeSetupToken(tokenId) {
  const { rowCount } = await query(
    `UPDATE setup_tokens SET consumed_at = now()
      WHERE id = $1 AND consumed_at IS NULL AND expires_at > now()`,
    [tokenId],
  );
  return rowCount > 0;
}

/**
 * Issues a setup token at boot when no administrator can sign in yet.
 *
 * @returns {Promise<void>}
 */
export async function ensureSetupTokenIfNeeded() {
  if (await isBootstrapped()) return;

  const token = await issueSetupToken();
  const url = `${config.publicUrl}/setup?token=${token}`;
  console.log(
    `\n${'='.repeat(72)}\n` +
      'Quorum has no administrator yet. Open this URL to create the first admin account:\n\n' +
      `  ${url}\n\n` +
      'This link is valid for one hour. Restart the container to issue a new one.\n' +
      `${'='.repeat(72)}\n`,
  );
}
