import test from 'node:test';
import assert from 'node:assert/strict';
import {
  accessibleGroupIds,
  effectivePermissionsForGroup,
  effectivePermissionsForSurvey,
  groupsWithPermission,
  membershipWithDiscordGroup,
  surveyGroupSelection,
  unionOfPermissions,
} from './groupPermissions.js';
import { ALL_PERMISSIONS, PERMISSIONS, TIERS } from './permissionSet.js';

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

// ---------------------------------------------------------------------------
// A survey belongs to several groups
// ---------------------------------------------------------------------------

test('a survey\'s permissions are the union across the groups it belongs to', () => {
  // Holding surveys.write in Astro is enough to edit a survey placed on Astro
  // and Selections: each group owns it as fully as the other.
  const membership = [{ groupId: A, memberPermissions: ['surveys.write'] }];
  const perms = effectivePermissionsForSurvey(admin, [A, B], membership, []);
  assert.deepEqual([...perms], ['surveys.write']);
});

test('a survey in groups the caller holds nothing over grants nothing', () => {
  const membership = [{ groupId: A, memberPermissions: ALL_PERMISSIONS }];
  assert.equal(effectivePermissionsForSurvey(admin, [B, C], membership, []).size, 0);
});

test('a survey\'s permissions gather from every group it belongs to', () => {
  const membership = [
    { groupId: A, memberPermissions: ['surveys.write'] },
    { groupId: B, memberPermissions: ['results.read'] },
  ];
  assert.deepEqual(
    [...effectivePermissionsForSurvey(admin, [A, B], membership, [])].sort(),
    ['results.read', 'surveys.write'],
  );
});

test('a survey with no groups is nobody\'s to touch, except a super admin\'s', () => {
  const membership = [{ groupId: A, memberPermissions: ALL_PERMISSIONS }];
  assert.equal(effectivePermissionsForSurvey(admin, [], membership, []).size, 0);
  assert.deepEqual(
    [...effectivePermissionsForSurvey(superAdmin, [], [], [])].sort(),
    [...ALL_PERMISSIONS].sort(),
  );
});

// ---------------------------------------------------------------------------
// No default group to fall back on
// ---------------------------------------------------------------------------

test('an admin in no group now resolves to nothing at all', () => {
  // The default-group fallback is gone on purpose. This is what it means: an
  // account that reaches the panel and belongs to no group can do nothing in
  // it, anywhere, which is why creating one requires a group.
  const membership = membershipWithDiscordGroup(admin, [], null);

  assert.deepEqual(membership, []);
  assert.equal(effectivePermissionsForGroup(admin, A, membership, []).size, 0);
  assert.equal(unionOfPermissions(admin, membership, []).size, 0);
  assert.equal(accessibleGroupIds(admin, membership, []).size, 0);
});

test('a Discord role-derived admin resolves against the group the plugin names', () => {
  // Nobody creates these accounts and nobody picks a group for them, so the
  // plugin picks one for all of them.
  const derived = { tier: TIERS.ADMIN, discordAdminGroupId: A };
  const landing = { id: A, memberPermissions: ['surveys.write', 'results.read'] };
  const membership = membershipWithDiscordGroup(derived, [], landing);

  assert.deepEqual(membership, [
    { groupId: A, memberPermissions: ['surveys.write', 'results.read'], isAdmin: false },
  ]);
  assert.deepEqual(
    [...effectivePermissionsForGroup(derived, A, membership, [])].sort(),
    ['results.read', 'surveys.write'],
  );
  // And over nothing else.
  assert.equal(effectivePermissionsForGroup(derived, B, membership, []).size, 0);
});

test('a Discord role-derived admin with no group configured gets nothing', () => {
  // Unset is not "guess one": no group has been chosen for them, so they have
  // no access until somebody chooses.
  const derived = { tier: TIERS.ADMIN, discordAdminGroupId: null };
  assert.deepEqual(membershipWithDiscordGroup(derived, [], null), []);
  assert.deepEqual(membershipWithDiscordGroup({ tier: TIERS.ADMIN }, [], { id: A, memberPermissions: ALL_PERMISSIONS }), []);
});

test('the derived group is added to the real memberships, never instead of them', () => {
  const derived = { tier: TIERS.ADMIN, discordAdminGroupId: A };
  const landing = { id: A, memberPermissions: ['results.read'] };
  const membership = membershipWithDiscordGroup(
    derived,
    [{ groupId: B, memberPermissions: ['surveys.write'] }],
    landing,
  );

  assert.deepEqual([...accessibleGroupIds(derived, membership, [])].sort(), [A, B].sort());
});

test('the derived group is never added twice to somebody already in it', () => {
  const derived = { tier: TIERS.ADMIN, discordAdminGroupId: A };
  const membership = [{ groupId: A, memberPermissions: ['surveys.write'], isAdmin: true }];
  assert.equal(
    membershipWithDiscordGroup(derived, membership, { id: A, memberPermissions: [] }),
    membership,
  );
});

test('a plain admin with a group is unaffected by the Discord landing group', () => {
  const membership = [{ groupId: A, memberPermissions: ['surveys.write'] }];
  assert.equal(
    membershipWithDiscordGroup(admin, membership, { id: B, memberPermissions: ALL_PERMISSIONS }),
    membership,
  );
});

test('super admins are never given a synthetic membership', () => {
  const landing = { id: A, memberPermissions: ALL_PERMISSIONS };
  assert.deepEqual(membershipWithDiscordGroup(superAdmin, [], landing), []);
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

// ---------------------------------------------------------------------------
// A survey always has at least one group
// ---------------------------------------------------------------------------

test('creating a survey with no group is refused', () => {
  // Nothing supplies one on the creator's behalf any more, so an empty choice
  // is an error rather than a signal to reach for a default.
  for (const requested of [undefined, null, [], '', ['', '  ']]) {
    const selection = surveyGroupSelection(requested);
    assert.equal(selection.status, 400);
    assert.match(selection.error, /at least one group/);
  }
});

test('removing a survey\'s last group is refused, by the same rule', () => {
  // An update sends the whole set, so clearing it is what "remove the last one"
  // looks like on the wire. It is the same refusal, deliberately: a survey with
  // no groups is takeable by nobody and reachable by nobody.
  assert.equal(surveyGroupSelection([]).status, 400);
  assert.deepEqual(surveyGroupSelection([A]), { groupIds: [A] });
});

test('a group list is de-duplicated, and one id need not be a list', () => {
  assert.deepEqual(surveyGroupSelection([A, B, A]), { groupIds: [A, B] });
  assert.deepEqual(surveyGroupSelection(A), { groupIds: [A] });
});

// ---------------------------------------------------------------------------
// What the group selector offers
// ---------------------------------------------------------------------------

const GROUPS = [
  { id: A, name: 'Astro' },
  { id: B, name: 'Gaming' },
  { id: C, name: 'Public' },
];

test('the group selector offers only groups where the caller holds surveys.write', () => {
  const membership = [
    { groupId: A, memberPermissions: ['surveys.write'] },
    // Belonging to Gaming without the permission is not enough.
    { groupId: B, memberPermissions: ['results.read'] },
  ];

  assert.deepEqual(
    groupsWithPermission(admin, GROUPS, membership, [], PERMISSIONS.SURVEYS_WRITE),
    [{ id: A, name: 'Astro' }],
  );
});

test('the group selector counts a cross-group grant', () => {
  const membership = [{ groupId: A, memberPermissions: [] }];
  const grants = [{ sourceGroupId: A, targetGroupId: C, permissions: ['surveys.write'] }];

  assert.deepEqual(
    groupsWithPermission(admin, GROUPS, membership, grants, PERMISSIONS.SURVEYS_WRITE),
    [{ id: C, name: 'Public' }],
  );
});

test('the group selector offers a super admin every group, and an admin in none nothing', () => {
  assert.deepEqual(groupsWithPermission(superAdmin, GROUPS, [], [], PERMISSIONS.SURVEYS_WRITE), [
    { id: A, name: 'Astro' },
    { id: B, name: 'Gaming' },
    { id: C, name: 'Public' },
  ]);
  assert.deepEqual(groupsWithPermission(admin, GROUPS, [], [], PERMISSIONS.SURVEYS_WRITE), []);
});
