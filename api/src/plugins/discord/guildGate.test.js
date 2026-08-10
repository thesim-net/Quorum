import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ACCESS,
  everyGroupRequiresGuild,
  refusal,
  requiresGuild,
  resolveAccess,
  resolveGroupAccess,
} from './guildGate.js';

const MEMBER = { discordId: '900000000000000001', roleIds: ['role-mod', 'role-veteran'] };

/** Every Discord lookup, wired to fail the test if the gate reaches for it. */
const untouchable = {
  member: () => {
    throw new Error('Discord must not be consulted here.');
  },
  canSeeChannel: () => {
    throw new Error('Discord must not be consulted here.');
  },
};

/**
 * Builds one group's audience rules.
 *
 * @param {object} fields Overrides.
 * @returns {object} Audience.
 */
const group = (fields = {}) => ({
  require_guild: false,
  gate_role_ids: [],
  gate_channel_ids: [],
  ...fields,
});

/**
 * Discord lookups that answer without a network.
 *
 * @param {object|null} member What the membership call returns.
 * @param {string[]} visibleChannels Channels the member can see.
 * @returns {object} Injectable lookups.
 */
const discord = (member, visibleChannels = []) => ({
  member: async () => member,
  canSeeChannel: async (channelId) => visibleChannels.includes(channelId),
});

test('an unchecked group opens without Discord being consulted at all', async () => {
  // Role and channel lists left over from before the checkbox existed are not
  // evaluated either: unchecked means anonymous, whatever else is configured.
  const outcome = await resolveAccess(
    {
      audience: group({ gate_role_ids: ['role-mod'], gate_channel_ids: ['channel-vip'] }),
      pluginReady: true,
      discordId: null,
    },
    untouchable,
  );
  assert.equal(outcome, ACCESS.OPEN);
  assert.equal(requiresGuild(group()), false);
});

test('a checked group with nobody signed in asks for Discord, and asks nothing of Discord', async () => {
  const outcome = await resolveAccess(
    { audience: group({ require_guild: true }), pluginReady: true, discordId: null },
    untouchable,
  );
  assert.equal(outcome, ACCESS.SIGN_IN_REQUIRED);
});

test('a checked group fails closed while the plugin is unavailable', async () => {
  const outcome = await resolveAccess(
    {
      audience: group({ require_guild: true }),
      pluginReady: false,
      discordId: MEMBER.discordId,
    },
    untouchable,
  );
  // Never downgraded to anonymous, and never admitted on the deployment's word.
  assert.equal(outcome, ACCESS.UNAVAILABLE);
});

test('a member of the server passes when nothing narrows it further', async () => {
  const outcome = await resolveAccess(
    { audience: group({ require_guild: true }), pluginReady: true, discordId: MEMBER.discordId },
    discord(MEMBER),
  );
  assert.equal(outcome, ACCESS.OPEN);
});

test('someone outside the server is refused', async () => {
  const outcome = await resolveAccess(
    { audience: group({ require_guild: true }), pluginReady: true, discordId: '404' },
    discord(null),
  );
  assert.equal(outcome, ACCESS.NOT_A_MEMBER);
});

test('role narrowing takes any one of the listed roles', async () => {
  const gated = group({ require_guild: true, gate_role_ids: ['role-veteran', 'role-staff'] });
  const request = { audience: gated, pluginReady: true, discordId: MEMBER.discordId };

  assert.equal(await resolveAccess(request, discord(MEMBER)), ACCESS.OPEN);
  assert.equal(
    await resolveAccess(request, discord({ ...MEMBER, roleIds: ['role-newcomer'] })),
    ACCESS.NARROWED_OUT,
  );
});

test('channel narrowing takes any one of the listed channels', async () => {
  const gated = group({ require_guild: true, gate_channel_ids: ['channel-vip', 'channel-crew'] });
  const request = { audience: gated, pluginReady: true, discordId: MEMBER.discordId };

  assert.equal(await resolveAccess(request, discord(MEMBER, ['channel-crew'])), ACCESS.OPEN);
  assert.equal(await resolveAccess(request, discord(MEMBER, ['channel-lobby'])), ACCESS.NARROWED_OUT);
});

test('roles and channels together are both required', async () => {
  const gated = group({
    require_guild: true,
    gate_role_ids: ['role-veteran'],
    gate_channel_ids: ['channel-vip'],
  });
  const request = { audience: gated, pluginReady: true, discordId: MEMBER.discordId };

  assert.equal(await resolveAccess(request, discord(MEMBER, ['channel-vip'])), ACCESS.OPEN);

  // The role alone is not enough.
  assert.equal(await resolveAccess(request, discord(MEMBER, [])), ACCESS.NARROWED_OUT);

  // Neither is the channel alone.
  assert.equal(
    await resolveAccess(
      request,
      discord({ ...MEMBER, roleIds: ['role-newcomer'] }, ['channel-vip']),
    ),
    ACCESS.NARROWED_OUT,
  );
});

test('a failed role check never goes on to ask about channels', async () => {
  const gated = group({
    require_guild: true,
    gate_role_ids: ['role-staff'],
    gate_channel_ids: ['channel-vip'],
  });

  const outcome = await resolveAccess(
    { audience: gated, pluginReady: true, discordId: MEMBER.discordId },
    { member: async () => MEMBER, canSeeChannel: untouchable.canSeeChannel },
  );
  assert.equal(outcome, ACCESS.NARROWED_OUT);
});

test('an unreachable Discord admits nobody new to a gated group', async () => {
  const gated = group({ require_guild: true, gate_channel_ids: ['channel-vip'] });
  const request = { audience: gated, pluginReady: true, discordId: MEMBER.discordId };

  const membershipDown = {
    member: async () => {
      throw new Error('Discord GET /guilds/1/members/2 failed');
    },
    canSeeChannel: untouchable.canSeeChannel,
  };
  assert.equal(await resolveAccess(request, membershipDown), ACCESS.UNAVAILABLE);

  const channelsDown = {
    member: async () => MEMBER,
    canSeeChannel: async () => {
      throw new Error('Discord GET /guilds/1/channels failed');
    },
  };
  assert.equal(await resolveAccess(request, channelsDown), ACCESS.UNAVAILABLE);
});

// ---------------------------------------------------------------------------
// A survey belongs to several groups, and any one of them opens it
// ---------------------------------------------------------------------------

const SELECTIONS = group({ require_guild: true, gate_role_ids: ['role-veteran'] });
const ASTRO = group({ require_guild: true, gate_role_ids: ['role-astro'] });
const GAMING = group({ require_guild: true, gate_channel_ids: ['channel-crew'] });
const PUBLIC = group();

test('qualifying under any one of a survey\'s groups is enough', async () => {
  const audiences = [SELECTIONS, ASTRO, GAMING];
  const request = { audiences, pluginReady: true, discordId: MEMBER.discordId };

  // Under Selections, by role.
  assert.equal(await resolveGroupAccess(request, discord(MEMBER)), ACCESS.OPEN);

  // Under Astro, by a different role, with Selections' role absent.
  assert.equal(
    await resolveGroupAccess(request, discord({ ...MEMBER, roleIds: ['role-astro'] })),
    ACCESS.OPEN,
  );

  // Under Gaming, by a channel, holding neither group's role.
  assert.equal(
    await resolveGroupAccess(
      request,
      discord({ ...MEMBER, roleIds: ['role-newcomer'] }, ['channel-crew']),
    ),
    ACCESS.OPEN,
  );
});

test('qualifying under none of them is refused, without saying which', async () => {
  const outcome = await resolveGroupAccess(
    { audiences: [SELECTIONS, ASTRO, GAMING], pluginReady: true, discordId: MEMBER.discordId },
    discord({ ...MEMBER, roleIds: ['role-newcomer'] }, ['channel-lobby']),
  );
  assert.equal(outcome, ACCESS.NARROWED_OUT);
  assert.doesNotMatch(refusal(outcome).reason, /role|channel|group/i);
});

test('one group with no bounds makes the survey open to anyone', async () => {
  // The "Public" case: a survey placed on Public and on Astro is takeable by
  // anybody, and costs no Discord call to establish it.
  const outcome = await resolveGroupAccess(
    { audiences: [ASTRO, PUBLIC], pluginReady: true, discordId: null },
    untouchable,
  );
  assert.equal(outcome, ACCESS.OPEN);
});

test('an open group is evaluated first, whatever order the groups arrive in', async () => {
  // Ordering is not cosmetic: it is what keeps "no sign-in, no Discord call"
  // true for a survey anybody can take.
  for (const audiences of [
    [PUBLIC, ASTRO, GAMING],
    [ASTRO, GAMING, PUBLIC],
  ]) {
    assert.equal(
      await resolveGroupAccess({ audiences, pluginReady: true, discordId: null }, untouchable),
      ACCESS.OPEN,
    );
  }
});

test('a survey in no group at all admits nobody', async () => {
  // The API keeps this from happening. It fails closed rather than reading "no
  // rules" as "no restrictions".
  assert.equal(
    await resolveGroupAccess({ audiences: [], pluginReady: true, discordId: null }, untouchable),
    ACCESS.NARROWED_OUT,
  );
});

test('the refusal reported is the one the person can act on', async () => {
  // Signing in may still open the survey, so it outranks every settled refusal.
  assert.equal(
    await resolveGroupAccess(
      { audiences: [SELECTIONS, ASTRO], pluginReady: true, discordId: null },
      untouchable,
    ),
    ACCESS.SIGN_IN_REQUIRED,
  );

  // An outage is never reported as a verdict on the account.
  const down = {
    member: async () => {
      throw new Error('Discord GET /guilds/1/members/2 failed');
    },
    canSeeChannel: untouchable.canSeeChannel,
  };
  assert.equal(
    await resolveGroupAccess(
      { audiences: [SELECTIONS, ASTRO], pluginReady: true, discordId: MEMBER.discordId },
      down,
    ),
    ACCESS.UNAVAILABLE,
  );

  // Joining the server comes before qualifying within it.
  assert.equal(
    await resolveGroupAccess(
      { audiences: [SELECTIONS, ASTRO], pluginReady: true, discordId: '404' },
      discord(null),
    ),
    ACCESS.NOT_A_MEMBER,
  );
});

test('a survey only counts Discord accounts when every way in goes through Discord', () => {
  // One open group leaves an anonymous route in, and some of those respondents
  // will have no Discord account to count them by.
  assert.equal(everyGroupRequiresGuild([SELECTIONS, ASTRO]), true);
  assert.equal(everyGroupRequiresGuild([SELECTIONS, PUBLIC]), false);
  assert.equal(everyGroupRequiresGuild([PUBLIC]), false);
  assert.equal(everyGroupRequiresGuild([]), false);
});

test('a refusal names the server but never the roles or channels behind it', () => {
  const narrowed = refusal(ACCESS.NARROWED_OUT, 'Our Simulacra (Benn Jordan)');
  assert.equal(narrowed.status, 403);
  assert.equal(narrowed.code, 'not_eligible');
  assert.match(narrowed.reason, /does not have access/);
  assert.doesNotMatch(narrowed.reason, /role|channel/i);

  const outsider = refusal(ACCESS.NOT_A_MEMBER, 'Our Simulacra (Benn Jordan)');
  assert.match(outsider.reason, /Our Simulacra \(Benn Jordan\)/);
  assert.equal(outsider.guild, 'Our Simulacra (Benn Jordan)');
});

test('an unknown server name falls back rather than leaving a gap in the sentence', () => {
  const anonymous = refusal(ACCESS.SIGN_IN_REQUIRED, null);
  assert.match(anonymous.reason, /the Discord server this survey was made for/);
  assert.equal(anonymous.guild, null);
});

test('being unable to open a survey never says why the deployment cannot', () => {
  const unavailable = refusal(ACCESS.UNAVAILABLE, 'Our Simulacra (Benn Jordan)');
  assert.equal(unavailable.status, 503);
  assert.match(unavailable.reason, /Try again shortly/);
  assert.doesNotMatch(unavailable.reason, /plugin|configur|enabled|Discord/i);
});
