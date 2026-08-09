import test from 'node:test';
import assert from 'node:assert/strict';
import { canViewChannel } from './permissions.js';

const GUILD_ID = '100';
const OWNER_ID = '999';
const MEMBER_ID = '200';
const ROLE_MEMBER = '300';
const ROLE_ADMIN = '400';

const VIEW = 1n << 10n;
const ADMIN = 1n << 3n;

const guild = { id: GUILD_ID, ownerId: OWNER_ID };

/**
 * Builds the role permission map used by every case below.
 *
 * @param {bigint} everyone Permissions granted by @everyone.
 * @returns {Map<string, bigint>} Role snowflake -> permission bits.
 */
const roles = (everyone) =>
  new Map([
    [GUILD_ID, everyone],
    [ROLE_MEMBER, 0n],
    [ROLE_ADMIN, ADMIN],
  ]);

/**
 * Builds a channel with the given overwrites.
 *
 * @param {Array<{id: string, type: number, allow: bigint, deny: bigint}>} overwrites
 * @returns {object} Channel object shaped like Discord's API response.
 */
const channel = (overwrites = []) => ({
  id: '500',
  type: 0,
  permission_overwrites: overwrites.map((o) => ({
    id: o.id,
    type: o.type,
    allow: String(o.allow),
    deny: String(o.deny),
  })),
});

test('member with no view permission is refused', () => {
  assert.equal(
    canViewChannel({
      guild,
      channel: channel(),
      memberRoleIds: [ROLE_MEMBER],
      memberId: MEMBER_ID,
      rolePermissions: roles(0n),
    }),
    false,
  );
});

test('a role overwrite can grant view on an otherwise hidden channel', () => {
  const hidden = channel([
    { id: GUILD_ID, type: 0, allow: 0n, deny: VIEW },
    { id: ROLE_MEMBER, type: 0, allow: VIEW, deny: 0n },
  ]);

  assert.equal(
    canViewChannel({
      guild,
      channel: hidden,
      memberRoleIds: [ROLE_MEMBER],
      memberId: MEMBER_ID,
      rolePermissions: roles(VIEW),
    }),
    true,
  );

  // Same channel, member without the role.
  assert.equal(
    canViewChannel({
      guild,
      channel: hidden,
      memberRoleIds: [],
      memberId: MEMBER_ID,
      rolePermissions: roles(VIEW),
    }),
    false,
  );
});

test('a member overwrite beats the role overwrite', () => {
  const denied = channel([
    { id: ROLE_MEMBER, type: 0, allow: VIEW, deny: 0n },
    { id: MEMBER_ID, type: 1, allow: 0n, deny: VIEW },
  ]);

  assert.equal(
    canViewChannel({
      guild,
      channel: denied,
      memberRoleIds: [ROLE_MEMBER],
      memberId: MEMBER_ID,
      rolePermissions: roles(VIEW),
    }),
    false,
  );
});

test('administrators cannot be denied by an overwrite', () => {
  assert.equal(
    canViewChannel({
      guild,
      channel: channel([{ id: GUILD_ID, type: 0, allow: 0n, deny: VIEW }]),
      memberRoleIds: [ROLE_ADMIN],
      memberId: MEMBER_ID,
      rolePermissions: roles(0n),
    }),
    true,
  );
});

test('the guild owner always has access', () => {
  assert.equal(
    canViewChannel({
      guild,
      channel: channel([{ id: GUILD_ID, type: 0, allow: 0n, deny: VIEW }]),
      memberRoleIds: [],
      memberId: OWNER_ID,
      rolePermissions: roles(0n),
    }),
    true,
  );
});

test('a thread resolves against its parent channel', () => {
  const parent = channel([
    { id: GUILD_ID, type: 0, allow: 0n, deny: VIEW },
    { id: ROLE_MEMBER, type: 0, allow: VIEW, deny: 0n },
  ]);
  const thread = { id: '600', type: 11, parent_id: parent.id, permission_overwrites: [] };

  assert.equal(
    canViewChannel({
      guild,
      channel: thread,
      parentChannel: parent,
      memberRoleIds: [ROLE_MEMBER],
      memberId: MEMBER_ID,
      rolePermissions: roles(VIEW),
    }),
    true,
  );

  assert.equal(
    canViewChannel({
      guild,
      channel: thread,
      parentChannel: parent,
      memberRoleIds: [],
      memberId: MEMBER_ID,
      rolePermissions: roles(VIEW),
    }),
    false,
  );
});
