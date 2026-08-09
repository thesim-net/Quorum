import test from 'node:test';
import assert from 'node:assert/strict';
import {
  accessibleGroupIds,
  effectivePermissionsForGroup,
  membershipWithFallback,
  unionOfPermissions,
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

test('fallback-to-default: an admin in no group is the only thing standing in for one', () => {
  // There is no per-user permission list left to fall back to, so an admin
  // created without a group gets exactly what the default group grants, over
  // the default group's surveys and nothing else.
  const defaultGroup = { id: 'default', memberPermissions: ['surveys.write', 'results.read'] };
  const membership = membershipWithFallback(admin, [], defaultGroup);

  assert.deepEqual(
    [...effectivePermissionsForGroup(admin, 'default', membership, [])].sort(),
    ['results.read', 'surveys.write'],
  );
  assert.equal(effectivePermissionsForGroup(admin, A, membership, []).size, 0);
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

test('the union is what the caller holds across all their groups', () => {
  // What /admin/me reports: enough to know which buttons are worth drawing.
  const membership = [
    { groupId: A, memberPermissions: ['surveys.write'] },
    { groupId: B, memberPermissions: ['surveys.publish'] },
  ];
  const perms = unionOfPermissions(admin, membership, []);
  assert.deepEqual([...perms].sort(), ['surveys.publish', 'surveys.write']);
});

test('the union counts permissions reached through a grant', () => {
  const membership = [{ groupId: A, memberPermissions: ['surveys.write'] }];
  const grants = [{ sourceGroupId: A, targetGroupId: B, permissions: ['results.read'] }];
  assert.deepEqual(
    [...unionOfPermissions(admin, membership, grants)].sort(),
    ['results.read', 'surveys.write'],
  );
});

test('the union ignores grants held by groups the caller is not in', () => {
  const membership = [{ groupId: A, memberPermissions: [] }];
  const grants = [{ sourceGroupId: C, targetGroupId: A, permissions: ['surveys.delete'] }];
  assert.equal(unionOfPermissions(admin, membership, grants).size, 0);
});

test('the union is never authorisation: it says "somewhere", not "here"', () => {
  // Holding surveys.delete over B must not read as holding it over A. This is
  // the whole reason the union is advisory and requireSurveyPermission is not.
  const membership = [{ groupId: A, memberPermissions: [] }];
  const grants = [{ sourceGroupId: A, targetGroupId: B, permissions: ['surveys.delete'] }];

  assert.deepEqual([...unionOfPermissions(admin, membership, grants)], ['surveys.delete']);
  assert.equal(effectivePermissionsForGroup(admin, A, membership, grants).size, 0);
});

test('a super admin\'s union is every permission, with no membership', () => {
  assert.deepEqual([...unionOfPermissions(superAdmin, [], [])].sort(), [...ALL_PERMISSIONS].sort());
});
