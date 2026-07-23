/**
 * Environment-derived configuration.
 *
 * Every value is read once at boot so a missing required variable fails the
 * process immediately rather than at the first request that needs it.
 */

/**
 * Reads a required environment variable.
 *
 * @param {string} name Variable name.
 * @returns {string} The value.
 * @throws {Error} When the variable is unset or empty.
 */
function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

/**
 * Reads an optional comma-separated list.
 *
 * @param {string} name Variable name.
 * @returns {string[]} Trimmed, non-empty entries.
 */
function list(name) {
  return (process.env[name] ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

const publicUrl = required('PUBLIC_URL').replace(/\/$/, '');

export const config = {
  env: process.env.NODE_ENV ?? 'development',
  port: Number(process.env.PORT ?? 3000),
  publicUrl,
  databaseUrl: required('DATABASE_URL'),

  sessionSecret: required('SESSION_SECRET'),
  sessionTtlDays: Number(process.env.SESSION_TTL_DAYS ?? 14),
  // How long a session's cached role snapshot is trusted before Discord is
  // re-queried. Keeps gate checks off the network without letting a removed
  // role grant access indefinitely.
  roleCacheSeconds: Number(process.env.ROLE_CACHE_SECONDS ?? 300),

  respondentPepper: required('RESPONDENT_PEPPER'),

  // Optional. Supplying all four pins the configuration to the environment and
  // makes the setup wizard read-only; leaving them unset is the normal path,
  // where credentials come from the wizard and live in the database.
  discord: {
    clientId: process.env.DISCORD_CLIENT_ID ?? '',
    clientSecret: process.env.DISCORD_CLIENT_SECRET ?? '',
    botToken: process.env.DISCORD_BOT_TOKEN ?? '',
    guildId: process.env.DISCORD_GUILD_ID ?? '',
    redirectUri: `${publicUrl}/api/auth/callback`,
  },

  // Members listed here are admins regardless of their Discord roles, so the
  // first deployment has a way in before any role is configured.
  bootstrapAdminIds: list('BOOTSTRAP_ADMIN_IDS'),
  adminRoleIds: list('ADMIN_ROLE_IDS'),

  // Local preview only: lets a browser sign in without a Discord application.
  // It activates only when NODE_ENV is *explicitly* development, so an unset or
  // unexpected value (staging, blank) never silently enables it. The check
  // below turns any other value into a hard boot failure.
  devAuthBypass: process.env.DEV_AUTH_BYPASS === '1' && process.env.NODE_ENV === 'development',

  geoipDbPath: process.env.GEOIP_DB_PATH ?? '',
  // Local directory holding uploaded file answers.
  uploadsDir: process.env.UPLOADS_DIR ?? '/data/uploads',
  // Update checking (UPDATE_CHECK, UPDATE_CHECK_REPO) is read directly from the
  // environment in lib/update.js.
  // Number of proxies in front of the API, used to pick the client IP out of
  // X-Forwarded-For without trusting a client-supplied header.
  trustProxyHops: Number(process.env.TRUST_PROXY_HOPS ?? 1),
};

// Fail closed: the bypass is only ever legitimate under an explicit
// NODE_ENV=development. If the flag is set with any other value - production,
// staging, or unset - refuse to start rather than risk silently disabling
// Discord sign-in on something that is not a local dev box.
if (process.env.DEV_AUTH_BYPASS === '1' && process.env.NODE_ENV !== 'development') {
  throw new Error(
    'DEV_AUTH_BYPASS is set but NODE_ENV is not "development". It disables Discord ' +
      'sign-in entirely and must never be enabled outside local development.',
  );
}

if (config.devAuthBypass) {
  console.warn(
    '\n*** DEV_AUTH_BYPASS is on. Anyone can sign in as anyone, without Discord. ***\n' +
      '*** Local preview only - never expose this to a network.                  ***\n',
  );
}
