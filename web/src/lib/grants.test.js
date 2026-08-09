import test from 'node:test';
import assert from 'node:assert/strict';
import {
  findGrant,
  grantTargets,
  listGrants,
  permissionNames,
  togglePermission,
} from './grants.js';

const catalogue = [
  { key: 'surveys.write', label: 'Create and edit surveys' },
  { key: 'surveys.publish', label: 'Open and close surveys' },
  { key: 'surveys.delete', label: 'Delete surveys' },
  { key: 'results.read', label: 'View results and export data' },
];

/**
 * Three groups: Writers grants Editors two permissions, Editors grants
 * Auditors one, and Auditors grants nothing.
 *
 * @returns {Array<object>} Groups shaped as GET /admin/groups returns them.
 */
const sample = () => [
  {
    id: 'w',
    name: 'Writers',
    grants: [{ targetGroupId: 'e', permissions: ['surveys.write', 'results.read'] }],
  },
  { id: 'e', name: 'Editors', grants: [{ targetGroupId: 'a', permissions: ['results.read'] }] },
  { id: 'a', name: 'Auditors', grants: [] },
];

test('findGrant returns the permissions held over a target', () => {
  assert.deepEqual(findGrant(sample(), 'w', 'e'), ['surveys.write', 'results.read']);
});

test('findGrant returns null for a pair with no grant', () => {
  assert.equal(findGrant(sample(), 'w', 'a'), null);
});

test('findGrant returns null for a group against itself', () => {
  assert.equal(findGrant(sample(), 'w', 'w'), null);
});

test('findGrant returns null when either side is unchosen', () => {
  assert.equal(findGrant(sample(), '', 'e'), null);
  assert.equal(findGrant(sample(), 'w', ''), null);
});

test('findGrant treats an empty permission list as no grant', () => {
  const groups = [{ id: 'w', name: 'Writers', grants: [{ targetGroupId: 'e', permissions: [] }] }];
  assert.equal(findGrant(groups, 'w', 'e'), null);
});

test('findGrant hands back a copy, so editing it cannot mutate the loaded data', () => {
  const groups = sample();
  findGrant(groups, 'w', 'e').push('surveys.delete');
  assert.deepEqual(groups[0].grants[0].permissions, ['surveys.write', 'results.read']);
});

test('listGrants flattens one row per grant, named on both sides', () => {
  assert.deepEqual(listGrants(sample()), [
    {
      sourceId: 'e',
      sourceName: 'Editors',
      targetId: 'a',
      targetName: 'Auditors',
      permissions: ['results.read'],
    },
    {
      sourceId: 'w',
      sourceName: 'Writers',
      targetId: 'e',
      targetName: 'Editors',
      permissions: ['surveys.write', 'results.read'],
    },
  ]);
});

test('listGrants is empty when nothing is granted', () => {
  assert.deepEqual(listGrants([{ id: 'w', name: 'Writers', grants: [] }]), []);
});

test('listGrants skips a grant onto a group that is gone', () => {
  const groups = [
    { id: 'w', name: 'Writers', grants: [{ targetGroupId: 'gone', permissions: ['results.read'] }] },
  ];
  assert.deepEqual(listGrants(groups), []);
});

test('listGrants orders by source then target name', () => {
  const groups = [
    {
      id: 'b',
      name: 'Beta',
      grants: [
        { targetGroupId: 'c', permissions: ['results.read'] },
        { targetGroupId: 'a', permissions: ['results.read'] },
      ],
    },
    { id: 'a', name: 'Alpha', grants: [{ targetGroupId: 'c', permissions: ['results.read'] }] },
    { id: 'c', name: 'Gamma', grants: [] },
  ];
  assert.deepEqual(
    listGrants(groups).map((row) => `${row.sourceName}->${row.targetName}`),
    ['Alpha->Gamma', 'Beta->Alpha', 'Beta->Gamma'],
  );
});

test('grantTargets never offers the source group itself', () => {
  assert.deepEqual(
    grantTargets(sample(), 'w').map((group) => group.id),
    ['e', 'a'],
  );
});

test('grantTargets offers every group before a source is chosen', () => {
  assert.equal(grantTargets(sample(), '').length, 3);
});

test('togglePermission adds then removes', () => {
  assert.deepEqual(togglePermission(['results.read'], 'surveys.write'), [
    'results.read',
    'surveys.write',
  ]);
  assert.deepEqual(togglePermission(['results.read', 'surveys.write'], 'results.read'), [
    'surveys.write',
  ]);
});

test('permissionNames labels in catalogue order, dropping unknown keys', () => {
  assert.deepEqual(permissionNames(catalogue, ['results.read', 'surveys.write', 'nope']), [
    'Create and edit surveys',
    'View results and export data',
  ]);
});
