import test from 'node:test';
import assert from 'node:assert/strict';
import { isNewer, parseSemver } from './update.js';

test('parseSemver tolerates a leading v and extracts parts', () => {
  assert.deepEqual(parseSemver('v1.2.3'), [1, 2, 3]);
  assert.deepEqual(parseSemver('1.0.0'), [1, 0, 0]);
  assert.equal(parseSemver('not-a-version'), null);
  assert.equal(parseSemver(undefined), null);
});

test('isNewer compares versions componentwise', () => {
  assert.equal(isNewer('v1.0.1', '1.0.0'), true);
  assert.equal(isNewer('v1.1.0', '1.0.9'), true);
  assert.equal(isNewer('v2.0.0', '1.9.9'), true);
  assert.equal(isNewer('v1.0.0', '1.0.0'), false);
  assert.equal(isNewer('v1.0.0', '1.0.1'), false);
  assert.equal(isNewer('v0.9.0', '1.0.0'), false);
});

test('a malformed version is never treated as an update', () => {
  assert.equal(isNewer('garbage', '1.0.0'), false);
  assert.equal(isNewer('v1.0.1', 'garbage'), false);
});
