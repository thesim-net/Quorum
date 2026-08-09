import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
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

test('a group admin inviting without naming a group lands in their own', () => {
  // Not the deployment default, which is what an ordinary account with no group
  // falls back to: a group admin only ever invites into their own group.
  const target = resolveInviteGroup(admin, [member(A, true), member(B)], null);
  assert.deepEqual(target, { groupId: A });
});

test('a group admin naming a group they do not administer is refused', () => {
  // Being an ordinary member of B is not enough, which is the point.
  const target = resolveInviteGroup(admin, [member(A, true), member(B)], B);
  assert.equal(target.status, 403);
  assert.match(target.error, /only invite people into a group you administer/);
});

test('a group admin naming a group they administer is obeyed', () => {
  const membership = [member(A, true), member(B, true)];
  assert.deepEqual(resolveInviteGroup(admin, membership, B), { groupId: B });
});

test('somebody who administers nothing cannot invite anybody anywhere', () => {
  const target = resolveInviteGroup(admin, [member(A)], A);
  assert.equal(target.status, 403);
});

test('a super admin may name any group, or none at all', () => {
  assert.deepEqual(resolveInviteGroup(superAdmin, [], 'any-group'), { groupId: 'any-group' });
  assert.deepEqual(resolveInviteGroup(superAdmin, [], null), { groupId: null });
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
