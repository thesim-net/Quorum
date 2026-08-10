import test from 'node:test';
import assert from 'node:assert/strict';
import { countMemberships, groupCountLine } from './groupCounts.js';

/**
 * A membership as the groups endpoint returns it.
 *
 * @param {string} username
 * @param {boolean} administers Whether this membership administers its group.
 * @returns {{id: string, username: string, administers: boolean}}
 */
const member = (username, administers = false) => ({ id: username, username, administers });

test('an administrator is counted as an admin and never also as a member', () => {
  // The owner's own example: a group whose only entry administers it reads
  // "0 members · 1 admin", not "1 member · 1 admin".
  assert.deepEqual(countMemberships([member('informationcake', true)]), {
    members: 0,
    admins: 1,
  });
  assert.equal(groupCountLine([member('informationcake', true)], 0), '0 members · 1 admin');
});

test('an empty group still says so, on both counts', () => {
  assert.deepEqual(countMemberships([]), { members: 0, admins: 0 });
  assert.equal(groupCountLine([], 0), '0 members · 0 admins');
});

test('several of each are counted apart', () => {
  const members = [
    member('ada'),
    member('grace'),
    member('alan'),
    member('informationcake', true),
    member('katherine', true),
  ];

  assert.deepEqual(countMemberships(members), { members: 3, admins: 2 });
  assert.equal(groupCountLine(members, 3), '3 members · 2 admins · 3 super admins');
});

test('every count is singular at one and plural everywhere else', () => {
  assert.equal(groupCountLine([member('ada')], 1), '1 member · 0 admins · 1 super admin');
  assert.equal(
    groupCountLine([member('ada'), member('grace', true)], 2),
    '1 member · 1 admin · 2 super admins',
  );
  assert.equal(
    groupCountLine([member('ada'), member('grace')], 0),
    '2 members · 0 admins',
  );
});

test('super administrators are left out entirely when there are none', () => {
  // Not "0 super admins": a deployment without one is a different situation,
  // and it is not a fact about this group.
  assert.equal(groupCountLine([member('ada')], 0), '1 member · 0 admins');
  assert.doesNotMatch(groupCountLine([member('ada')], 0), /super/);
});

test('super administrators are never folded into the member count', () => {
  // They hold no membership at all, so the same line with and without them
  // differs only by its own segment.
  const members = [member('ada'), member('grace', true)];
  assert.equal(groupCountLine(members, 0), '1 member · 1 admin');
  assert.equal(groupCountLine(members, 1), '1 member · 1 admin · 1 super admin');
  assert.deepEqual(countMemberships(members), { members: 1, admins: 1 });
});

test('the counts survive a group with nothing passed at all', () => {
  assert.deepEqual(countMemberships(), { members: 0, admins: 0 });
  assert.equal(groupCountLine(), '0 members · 0 admins');
});
