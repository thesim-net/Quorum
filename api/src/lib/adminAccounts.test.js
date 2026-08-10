import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SUPER_ADMIN_NEEDS_NO_GROUP,
  administeredGroupIds,
  administersGroup,
  mayGrantGroupAdmin,
  mayGrantTier,
  requestedGroupId,
  requestedStanding,
  resolveInviteGroup,
  stripsLastSuperAdmin,
} from './adminAccounts.js';
import { TIERS } from './permissionSet.js';

const superAdmin = { tier: TIERS.SUPER };
const admin = { tier: TIERS.ADMIN };

const A = 'group-a';
const B = 'group-b';

/**
 * A membership row as loadGroupContext returns it.
 *
 * @param {string} groupId
 * @param {boolean} isAdmin Whether this membership administers its group.
 * @returns {{groupId: string, memberPermissions: string[], isAdmin: boolean}}
 */
const member = (groupId, isAdmin = false) => ({ groupId, memberPermissions: [], isAdmin });

// ---------------------------------------------------------------------------
// What a request asks for
// ---------------------------------------------------------------------------

test('a body with no permissions field is a complete request', () => {
  // The whole point of retiring per-user permissions: creating an admin needs a
  // name and a standing, and nothing about permissions is missing from this.
  const body = { username: 'newadmin' };
  assert.deepEqual(requestedStanding(body), { tier: TIERS.ADMIN, groupAdmin: false });
  assert.equal(requestedGroupId(body), null);
});

test('super admin and group admin are refused together, whatever the form did', () => {
  const standing = requestedStanding({ superAdmin: true, groupAdmin: true });
  assert.match(standing.error, /either a super administrator or a group administrator/);
  assert.equal(standing.tier, undefined);
});

test('either standing alone is accepted, and neither is valid too', () => {
  assert.deepEqual(requestedStanding({ superAdmin: true }), {
    tier: TIERS.SUPER,
    groupAdmin: false,
  });
  assert.deepEqual(requestedStanding({ groupAdmin: true }), {
    tier: TIERS.ADMIN,
    groupAdmin: true,
  });
  assert.deepEqual(requestedStanding({}), { tier: TIERS.ADMIN, groupAdmin: false });
});

test('a standing is only ever an explicit true', () => {
  assert.deepEqual(requestedStanding({ superAdmin: 'true' }), {
    tier: TIERS.ADMIN,
    groupAdmin: false,
  });
  assert.deepEqual(requestedStanding({ groupAdmin: 1 }), { tier: TIERS.ADMIN, groupAdmin: false });
  assert.deepEqual(requestedStanding(undefined), { tier: TIERS.ADMIN, groupAdmin: false });
});

test('a named group is carried through, and naming none stays none', () => {
  assert.equal(requestedGroupId({ groupId: A }), A);
  for (const body of [{}, { groupId: '' }, { groupId: null }, undefined]) {
    assert.equal(requestedGroupId(body), null);
  }
});

// ---------------------------------------------------------------------------
// Administering a group is a property of the membership
// ---------------------------------------------------------------------------

test('administering one group says nothing about another', () => {
  // The whole shape of the model: an is_admin membership of A plus an ordinary
  // membership of B administers A alone.
  const membership = [member(A, true), member(B)];
  assert.deepEqual([...administeredGroupIds(membership)], [A]);
  assert.equal(administersGroup(admin, membership, A), true);
  assert.equal(administersGroup(admin, membership, B), false);
});

test('merely belonging to a group administers nothing', () => {
  assert.equal(administersGroup(admin, [member(A)], A), false);
});

test('an is_admin membership of each group administers both', () => {
  const membership = [member(A, true), member(B, true)];
  assert.equal(administersGroup(admin, membership, A), true);
  assert.equal(administersGroup(admin, membership, B), true);
});

test('a super admin administers every group, with no membership at all', () => {
  assert.equal(administersGroup(superAdmin, [], 'any-group'), true);
});

// ---------------------------------------------------------------------------
// Where an invited account lands
// ---------------------------------------------------------------------------

test('creating an administrator without a group is refused', () => {
  // There is no default group to fall back on any more, so an administrator
  // created in no group would reach the panel and be able to do nothing in it.
  // The refusal is the whole feature: a silent lockout is worse than a form
  // error, and this is the one place no caller can skip.
  for (const caller of [superAdmin, admin]) {
    const target = resolveInviteGroup(caller, [member(A, true)], null, TIERS.ADMIN);
    assert.equal(target.status, 400);
    assert.match(target.error, /Choose the group they will belong to/);
  }
});

test('a group admin naming a group they do not administer is refused', () => {
  // Being an ordinary member of B is not enough, which is the point.
  const target = resolveInviteGroup(admin, [member(A, true), member(B)], B, TIERS.ADMIN);
  assert.equal(target.status, 403);
  assert.match(target.error, /only invite people into a group you administer/);
});

test('a group admin naming a group they administer is obeyed', () => {
  const membership = [member(A, true), member(B, true)];
  assert.deepEqual(resolveInviteGroup(admin, membership, B, TIERS.ADMIN), { groupId: B });
});

test('somebody who administers nothing cannot invite anybody anywhere', () => {
  const target = resolveInviteGroup(admin, [member(A)], A, TIERS.ADMIN);
  assert.equal(target.status, 403);
});

test('a super admin may name any group for a plain administrator', () => {
  assert.deepEqual(resolveInviteGroup(superAdmin, [], 'any-group', TIERS.ADMIN), {
    groupId: 'any-group',
  });
});

test('creating a super administrator takes no group, and refuses one offered', () => {
  // They bypass groups, so a membership would grant them nothing and only
  // suggest their access came from it. Refused rather than obeyed and undone.
  assert.deepEqual(resolveInviteGroup(superAdmin, [], null, TIERS.SUPER), { groupId: null });

  const target = resolveInviteGroup(superAdmin, [], A, TIERS.SUPER);
  assert.equal(target.status, 400);
  assert.equal(target.error, SUPER_ADMIN_NEEDS_NO_GROUP);
});

// ---------------------------------------------------------------------------
// What a caller may hand out
// ---------------------------------------------------------------------------

test('only a super administrator creates another super administrator', () => {
  assert.equal(mayGrantTier(admin, TIERS.SUPER), false);
  assert.equal(mayGrantTier(superAdmin, TIERS.SUPER), true);
  assert.equal(mayGrantTier(admin, TIERS.ADMIN), true);
});

test('a group admin may make further admins of the group they administer', () => {
  // Deliberately self-propagating within one group, at the owner's instruction.
  const verdict = mayGrantGroupAdmin(admin, new Set([A]), A, new Set());
  assert.deepEqual(verdict, { ok: true });
});

test('a group admin cannot promote inside a group they do not administer', () => {
  const verdict = mayGrantGroupAdmin(admin, new Set([A]), B, new Set());
  assert.equal(verdict.status, 403);
  assert.match(verdict.error, /do not administer that group/);
});

test('a group admin cannot make somebody an admin of a second group', () => {
  const verdict = mayGrantGroupAdmin(admin, new Set([A]), A, new Set([B]));
  assert.equal(verdict.status, 403);
  assert.match(verdict.error, /only a super administrator/);
});

test('a group admin may re-affirm somebody who already administers only this group', () => {
  assert.deepEqual(mayGrantGroupAdmin(admin, new Set([A]), A, new Set([A])), { ok: true });
});

test('a super admin may make somebody an administrator of several groups', () => {
  assert.deepEqual(mayGrantGroupAdmin(superAdmin, new Set(), A, new Set([B])), { ok: true });
});

// ---------------------------------------------------------------------------
// The last super administrator
// ---------------------------------------------------------------------------

test('the last super administrator cannot be demoted or removed', () => {
  assert.equal(stripsLastSuperAdmin({ targetTier: TIERS.SUPER, superAdminCount: 1 }), true);
});

test('the last-super guard does not fire while another one remains', () => {
  assert.equal(stripsLastSuperAdmin({ targetTier: TIERS.SUPER, superAdminCount: 2 }), false);
});

test('the last-super guard does not fire for a plain admin', () => {
  assert.equal(stripsLastSuperAdmin({ targetTier: TIERS.ADMIN, superAdminCount: 1 }), false);
  assert.equal(stripsLastSuperAdmin({ targetTier: undefined, superAdminCount: 1 }), false);
});

test('a Discord bootstrap super admin is another way in, so the guard relents', () => {
  assert.equal(
    stripsLastSuperAdmin({
      targetTier: TIERS.SUPER,
      superAdminCount: 1,
      otherSuperSource: true,
    }),
    false,
  );
});

// ---------------------------------------------------------------------------
// Contracts the routes have to keep
// ---------------------------------------------------------------------------

const apiRoot = fileURLToPath(new URL('..', import.meta.url));

/**
 * Every source file under src/, so the whole tree can be checked at once.
 *
 * @param {string} dir Directory to walk.
 * @returns {string[]} Absolute paths of .js files.
 */
function sourceFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith('.js') && !entry.name.endsWith('.test.js') ? [path] : [];
  });
}

test('nothing resolves against a default group any more', () => {
  // The fallback is gone, and with it the column. A query still naming
  // is_default would fail at runtime, and any decision still reaching for the
  // default group would be quietly handing out access nobody granted.
  const offenders = [];

  for (const file of sourceFiles(apiRoot)) {
    const source = readFileSync(file, 'utf8');
    if (/\bis_default\b|\bmembershipWithFallback\b/.test(source)) offenders.push(file);
  }

  assert.deepEqual(offenders, []);
});

test('nothing reads the survey columns the audience moved off', () => {
  // group_id, require_guild, gate_role_ids and gate_channel_ids are all gone
  // from surveys. Every one of them still exists on groups, so the check is for
  // the qualified survey forms rather than for the bare names.
  const offenders = [];

  for (const file of sourceFiles(apiRoot)) {
    const source = readFileSync(file, 'utf8');
    if (/\bs\.(?:group_id|require_guild|gate_role_ids|gate_channel_ids)\b/.test(source)) {
      offenders.push(file);
    }
    if (/\bsurveys\.(?:group_id|require_guild|gate_role_ids|gate_channel_ids)\b/.test(source)) {
      offenders.push(file);
    }
  }

  assert.deepEqual(offenders, []);
});

test('nothing reads a per-user permission list any more', () => {
  // Migration 014 drops users.permissions. A query still naming it would fail
  // at runtime, and any authorisation decision still consulting one would be
  // reading a column that no longer exists - so neither may come back.
  const offenders = [];

  for (const file of sourceFiles(apiRoot)) {
    const source = readFileSync(file, 'utf8');
    // `u.permissions` in a query, `users.permissions` in an upsert, and
    // `user.permissions` in a decision all name the dropped column. The group
    // columns - member_permissions, and group_grants.permissions - do not.
    if (/\b(?:u|user|users)\.permissions\b/.test(source)) offenders.push(file);
  }

  assert.deepEqual(offenders, []);
});

test('a super administrator can be put in no group, by either route', () => {
  // Both membership routes settle it through loadMemberTarget, so there is one
  // decision and one wording rather than a check bolted onto each.
  const source = readFileSync(join(apiRoot, 'routes', 'groups.js'), 'utf8');

  assert.match(source, /if \(rows\[0\]\.tier === TIERS\.SUPER\) \{[\s\S]*SUPER_ADMIN_NEEDS_NO_GROUP/);
  for (const route of [
    "groupsRouter.post('/:id/members'",
    "groupsRouter.patch('/:id/members/:userId'",
  ]) {
    const from = source.indexOf(route);
    assert.ok(from > 0, `${route} is gone`);

    // Up to whichever route is declared next, so the check reads that route's
    // own body rather than the first closing brace inside it.
    const next = source.indexOf('groupsRouter.', from + route.length);
    const body = source.slice(from, next === -1 ? undefined : next);
    assert.ok(
      body.includes('loadMemberTarget'),
      `${route} no longer refuses a super administrator`,
    );
  }
});

test('the assignable list never offers a super administrator', () => {
  // Filtered out at the source rather than left to be picked and then refused.
  const source = readFileSync(join(apiRoot, 'routes', 'groups.js'), 'utf8');
  assert.match(source, /tier <> 'none' AND tier <> 'super_admin'/);
});

test('promoting somebody to super administrator clears their memberships', () => {
  // The two states can never coexist, so the clearing shares the transaction
  // with the tier change rather than following it and hoping.
  const source = readFileSync(join(apiRoot, 'routes', 'admin.js'), 'utf8');
  const promotion = source.slice(source.indexOf('if (tier === TIERS.SUPER) {'));

  assert.match(
    promotion.slice(0, 400),
    /DELETE FROM group_members WHERE user_id = \$1/,
  );
  assert.ok(
    source.indexOf('const rowCount = await transaction') < source.indexOf('if (tier === TIERS.SUPER) {'),
    'the membership clear no longer shares the tier change transaction',
  );
});

test('demoting a super administrator requires somewhere to land', () => {
  // They hold no memberships by construction, so a demotion without a group is
  // the same silent lockout as creating an admin without one.
  const source = readFileSync(join(apiRoot, 'routes', 'admin.js'), 'utf8');
  assert.match(source, /const demoting = target\[0\]\.tier === TIERS\.SUPER && tier !== TIERS\.SUPER/);
  assert.match(source, /requiresGroup: true/);
});

test('removing somebody from their only group is refused', () => {
  // Membership is the whole of a plain administrator's access now, so this
  // would leave an account that reaches the panel and can do nothing in it.
  const source = readFileSync(join(apiRoot, 'routes', 'groups.js'), 'utf8');
  assert.match(source, /held\.length === 1 && held\[0\]\.group_id === req\.params\.id/);
  assert.match(source, /lastGroup: true/);
});

test('deleting a group that would strand a survey is refused', () => {
  // There is no default group to hand its surveys to any more, and a survey
  // must always have one. The count is of surveys in this group and no other.
  const source = readFileSync(join(apiRoot, 'routes', 'groups.js'), 'utf8');
  assert.match(source, /surveysAffected: stranded\[0\]\.n/);
  assert.match(source, /other\.survey_id = sg\.survey_id AND other\.group_id <> \$1/);
  // And never by quietly moving them somewhere.
  assert.doesNotMatch(source, /UPDATE surveys SET group/);
});

test('shaping groups stays super-admin only, and membership does not', () => {
  // Routes cannot be exercised without a live database, but which guard fronts
  // each one can be. Creating, renaming, deleting, re-permissioning and
  // cross-granting a group are deployment-shaping and stay with super admins;
  // a group's own membership is run by whoever administers THAT group, which
  // is what requireGroupControl asks.
  const source = readFileSync(join(apiRoot, 'routes', 'groups.js'), 'utf8');

  const guards = [
    ["groupsRouter.post('/'", 'requireAdmin'],
    ["groupsRouter.patch('/:id'", 'requireAdmin'],
    ["groupsRouter.delete('/:id'", 'requireAdmin'],
    ["groupsRouter.put('/:id/grants'", 'requireAdmin'],
    ["groupsRouter.post('/:id/members'", 'requireGroupControl()'],
    ["groupsRouter.patch('/:id/members/:userId'", 'requireGroupControl()'],
    ["groupsRouter.delete('/:id/members/:userId'", 'requireGroupControl()'],
  ];

  for (const [route, guard] of guards) {
    assert.ok(
      source.includes(`${route}, ${guard}`),
      `${route} is no longer guarded by ${guard}`,
    );
  }
});
