import { config } from '../config.js';
import { requireDiscord } from './settings.js';

const API = 'https://discord.com/api/v10';

class DiscordError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = 'DiscordError';
    this.status = status;
    this.body = body;
  }
}

/**
 * Issues a Discord REST call, retrying once when rate limited.
 *
 * @param {string} path Path below the API root, e.g. `/guilds/123`.
 * @param {{ auth: string, method?: string, body?: object }} options
 *   `auth` is the full Authorization header value.
 * @returns {Promise<object>} Parsed JSON response.
 * @throws {DiscordError} When Discord returns a non-2xx status.
 */
async function request(path, { auth, method = 'GET', body }) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await fetch(`${API}${path}`, {
      method,
      headers: {
        Authorization: auth,
        'Content-Type': 'application/json',
        'User-Agent': 'Quorum (self-hosted survey tool)',
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (response.status === 429 && attempt === 0) {
      const retryAfter = Number(response.headers.get('retry-after') ?? 1);
      await new Promise((resolve) => setTimeout(resolve, Math.min(retryAfter, 5) * 1000));
      continue;
    }

    const text = await response.text();
    const payload = text ? JSON.parse(text) : {};

    if (!response.ok) {
      throw new DiscordError(`Discord ${method} ${path} failed`, response.status, payload);
    }
    return payload;
  }
  throw new DiscordError(`Discord ${method} ${path} rate limited`, 429, {});
}

const bot = (path, options = {}) =>
  request(path, { ...options, auth: `Bot ${requireDiscord().botToken}` });

/**
 * Builds the Discord authorization URL a member is redirected to at login.
 *
 * @param {string} state Opaque CSRF token echoed back on the callback.
 * @returns {string} Fully qualified authorization URL.
 */
export function authorizeUrl(state) {
  const params = new URLSearchParams({
    client_id: requireDiscord().clientId,
    redirect_uri: config.discord.redirectUri,
    response_type: 'code',
    scope: 'identify',
    state,
    prompt: 'none',
  });
  return `${API}/oauth2/authorize?${params}`;
}

/**
 * Exchanges an OAuth authorization code for an access token.
 *
 * @param {string} code Code supplied on the OAuth callback.
 * @returns {Promise<{access_token: string, token_type: string}>} Token payload.
 */
export async function exchangeCode(code) {
  const response = await fetch(`${API}/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: requireDiscord().clientId,
      client_secret: requireDiscord().clientSecret,
      grant_type: 'authorization_code',
      code,
      redirect_uri: config.discord.redirectUri,
    }),
  });

  if (!response.ok) {
    throw new DiscordError('OAuth code exchange failed', response.status, await response.text());
  }
  return response.json();
}

/**
 * Reads the profile of the member who just authorized.
 *
 * @param {string} accessToken OAuth access token.
 * @returns {Promise<object>} Discord user object.
 */
export function currentUser(accessToken) {
  return request('/users/@me', { auth: `Bearer ${accessToken}` });
}

/**
 * Fetches a member of the configured guild.
 *
 * The bot token is used rather than the member's own OAuth token so membership
 * can be re-checked at any time, without the member being present and without
 * persisting a per-user token. That is what lets access end when someone leaves
 * the server rather than when their session happens to expire, and it is the
 * only way to look up a member who has never signed in - which the
 * add-admin-by-user-ID flow depends on.
 *
 * The OAuth alternative, the `guilds.members.read` scope, would cover the
 * signed-in user's own roles but neither of those cases.
 *
 * @param {string} discordId
 * @returns {Promise<object|null>} Guild member object, or null when the user is
 *   not in the guild.
 */
export async function guildMember(discordId) {
  try {
    return await bot(`/guilds/${requireDiscord().guildId}/members/${discordId}`);
  } catch (error) {
    if (error instanceof DiscordError && error.status === 404) return null;
    throw error;
  }
}

/**
 * Fetches the guild, including its owner id.
 *
 * @returns {Promise<object>} Discord guild object.
 */
export function guild() {
  return bot(`/guilds/${requireDiscord().guildId}`);
}

/**
 * Lists every role in the guild, for gate configuration and permission maths.
 *
 * @returns {Promise<object[]>} Array of Discord role objects.
 */
export function guildRoles() {
  return bot(`/guilds/${requireDiscord().guildId}/roles`);
}

/**
 * Lists every channel in the guild, including permission overwrites.
 *
 * @returns {Promise<object[]>} Array of Discord channel objects.
 */
export function guildChannels() {
  return bot(`/guilds/${requireDiscord().guildId}/channels`);
}

/**
 * Posts a message to a channel as the bot.
 *
 * Requires the bot to hold Send Messages in the channel; a permission failure
 * surfaces as a DiscordError the caller can report rather than swallow.
 *
 * @param {string} channelId Target channel.
 * @param {string} content Message text (Discord markdown).
 * @returns {Promise<object>} The created message.
 */
export function postMessage(channelId, content) {
  return bot(`/channels/${channelId}/messages`, {
    method: 'POST',
    body: { content: content.slice(0, 2000), allowed_mentions: { parse: [] } },
  });
}

/**
 * Checks a candidate set of credentials before they are saved.
 *
 * Verifies each piece independently so the wizard can say which one is wrong,
 * rather than reporting a single opaque failure.
 *
 * @param {{clientId: string, clientSecret: string, botToken: string, guildId: string}} values
 * @returns {Promise<{ok: boolean, problems: string[], guild: object|null,
 *   roleCount: number, channelCount: number, canViewChannels: boolean}>}
 *   Verification result, with the guild's details when everything checks out.
 */
export async function verifyCredentials(values) {
  const problems = [];
  const auth = `Bot ${values.botToken}`;

  if (!/^\d{17,20}$/.test(String(values.clientId ?? ''))) {
    problems.push('Client ID should be a Discord snowflake (17-20 digits).');
  }
  if (!/^\d{17,20}$/.test(String(values.guildId ?? ''))) {
    problems.push('Server ID should be a Discord snowflake (17-20 digits).');
  }
  if (!values.clientSecret) problems.push('Client secret is required.');
  if (!values.botToken) problems.push('Bot token is required.');
  if (problems.length > 0) return { ok: false, problems, guild: null, roleCount: 0, channelCount: 0, canViewChannels: false };

  // Does the bot token work at all?
  let botUser;
  try {
    botUser = await request('/users/@me', { auth });
  } catch (error) {
    return {
      ok: false,
      problems: ['The bot token was rejected by Discord. Check it was copied in full.'],
      guild: null,
      roleCount: 0,
      channelCount: 0,
      canViewChannels: false,
    };
  }

  // Is the bot actually in the server?
  let guildInfo;
  try {
    guildInfo = await request(`/guilds/${values.guildId}`, { auth });
  } catch (error) {
    const missing = error instanceof DiscordError && (error.status === 404 || error.status === 403);
    return {
      ok: false,
      problems: [
        missing
          ? `The bot is not in server ${values.guildId}. Invite it, then try again.`
          : 'Could not read the server from Discord.',
      ],
      guild: null,
      roleCount: 0,
      channelCount: 0,
      canViewChannels: false,
    };
  }

  // Channel gates need the bot to be able to enumerate channels.
  let channels = [];
  let canViewChannels = true;
  try {
    channels = await request(`/guilds/${values.guildId}/channels`, { auth });
  } catch {
    canViewChannels = false;
    problems.push(
      'The bot cannot list channels, so channel-based survey gates will not work. ' +
        'Grant it the View Channels permission.',
    );
  }

  const roles = await request(`/guilds/${values.guildId}/roles`, { auth });

  return {
    ok: true,
    problems,
    botUsername: botUser.username,
    guild: { id: guildInfo.id, name: guildInfo.name, ownerId: guildInfo.owner_id },
    roles: roles
      .filter((role) => role.id !== guildInfo.id)
      .sort((a, b) => b.position - a.position)
      .map((role) => ({ id: role.id, name: role.name })),
    // Text, announcement, and forum channels only; a voice channel cannot
    // meaningfully gate access.
    channels: channels
      .filter((channel) => [0, 5, 15].includes(channel.type))
      .sort((a, b) => a.position - b.position)
      .map((channel) => ({ id: channel.id, name: channel.name })),
    roleCount: roles.length,
    channelCount: channels.length,
    canViewChannels,
  };
}

export { DiscordError };
