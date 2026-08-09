import test from 'node:test';
import assert from 'node:assert/strict';
import {
  accessibleGroupIds,
  effectivePermissionsForGroup,
  membershipWithFallback,
} from './groupPermissions.js';
import { ALL_PERMISSIONS, TIERS } from './permissionSet.js';

const admin = { tier: TIERS.ADMIN };
const superAdmin = { tier: TIERS.SUPER };

const A = 'group-a';
const B = 'group-b';
const C = 'group-c';

test('a member gets their own group\'s member permissions', () => {
  const membership = [{ groupId: A, memberPermissions: ['surveys.write', 'results.read'] }];
  const perms = effectivePermissionsForGroup(admin, A, membership, []);
  assert.deepEqual([...perms].sort(), ['results.read', 'surveys.write']);
});

test('membership in another group grants nothing over this group', () => {
  const membership = [{ groupId: B, memberPermissions: ALL_PERMISSIONS }];
  const perms = effectivePermissionsForGroup(admin, A, membership, []);
  assert.equal(perms.size, 0);
});

test('a cross-group grant adds permissions over the target group', () => {
  const membership = [{ groupId: A, memberPermissions: ['surveys.write'] }];
  const grants = [{ sourceGroupId: A, targetGroupId: B, permissions: ['results.read', 'surveys.delete'] }];
  const perms = effectivePermissionsForGroup(admin, B, membership, grants);
  assert.deepEqual([...perms].sort(), ['results.read', 'surveys.delete']);
});

test('a grant only helps the group it targets', () => {
  const membership = [{ groupId: A, memberPermissions: [] }];
  const grants = [{ sourceGroupId: A, targetGroupId: B, permissions: ['results.read'] }];
  assert.equal(effectivePermissionsForGroup(admin, C, membership, grants).size, 0);
});

test('member permissions and grants union together on the owner', () => {
  const membership = [
    { groupId: A, memberPermissions: ['surveys.write'] },
    { groupId: B, memberPermissions: ['surveys.publish'] },
  ];
  const grants = [{ sourceGroupId: B, targetGroupId: A, permissions: ['results.read'] }];
  const perms = effectivePermissionsForGroup(admin, A, membership, grants);
  assert.deepEqual([...perms].sort(), ['results.read', 'surveys.write']);
});

test('unknown permission strings are filtered out', () => {
  const membership = [{ groupId: A, memberPermissions: ['surveys.write', 'surveys.nuke'] }];
  const perms = effectivePermissionsForGroup(admin, A, membership, []);
  assert.deepEqual([...perms], ['surveys.write']);
});

test('a super admin holds every permission over any group, with no membership', () => {
  const perms = effectivePermissionsForGroup(superAdmin, 'anything', [], []);
  assert.deepEqual([...perms].sort(), [...ALL_PERMISSIONS].sort());
});

test('accessibleGroupIds covers own groups plus grant targets', () => {
  const membership = [{ groupId: A, memberPermissions: [] }];
  const grants = [
    { sourceGroupId: A, targetGroupId: B, permissions: ['results.read'] },
    { sourceGroupId: C, targetGroupId: A, permissions: ['results.read'] }, // not the user's source
  ];
  const ids = accessibleGroupIds(admin, membership, grants);
  assert.deepEqual([...ids].sort(), [A, B].sort());
});

test('fallback-to-default: an admin in no group is treated as a default member', () => {
  const defaultGroup = { id: 'default', memberPermissions: ['results.read'] };
  const membership = membershipWithFallback(admin, [], defaultGroup);
  assert.deepEqual(membership, [{ groupId: 'default', memberPermissions: ['results.read'] }]);

  const perms = effectivePermissionsForGroup(admin, 'default', membership, []);
  assert.deepEqual([...perms], ['results.read']);
});

test('fallback-to-default: an admin who already has a group is left unchanged', () => {
  const defaultGroup = { id: 'default', memberPermissions: ALL_PERMISSIONS };
  const membership = [{ groupId: A, memberPermissions: ['surveys.write'] }];
  assert.equal(membershipWithFallback(admin, membership, defaultGroup), membership);
});

test('fallback-to-default: super admins are never given a synthetic membership', () => {
  const defaultGroup = { id: 'default', memberPermissions: ALL_PERMISSIONS };
  assert.deepEqual(membershipWithFallback(superAdmin, [], defaultGroup), []);
});
