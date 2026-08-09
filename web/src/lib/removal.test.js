import test from 'node:test';
import assert from 'node:assert/strict';
import { nameList, removalConsequences } from './removal.js';

test('nameList reads as a sentence at every length', () => {
  assert.equal(nameList([]), '');
  assert.equal(nameList(['Selections']), 'Selections');
  assert.equal(nameList(['Selections', 'Astro']), 'Selections and Astro');
  assert.equal(nameList(['A', 'B', 'C']), 'A, B and C');
});

test('a plain admin in no group is told what actually happens', () => {
  const lines = removalConsequences({ tier: 'admin', groups: [] });
  assert.ok(lines.some((line) => /lose administrator access/.test(line)));
  assert.ok(lines.some((line) => /account itself is kept/.test(line)));
  // Nothing to clear, so nothing is claimed about memberships.
  assert.equal(lines.some((line) => /membership of/.test(line)), false);
});

test('memberships are named, because removing clears them too', () => {
  const lines = removalConsequences({
    tier: 'admin',
    groups: [{ name: 'Selections' }, { name: 'Astro' }],
  });
  assert.ok(lines.some((line) => line.includes('Selections and Astro')));
});

test('a super administrator is called out first, where a mistake costs most', () => {
  const lines = removalConsequences({ tier: 'super_admin', groups: [] });
  assert.match(lines[0], /super administrator/);
});

test('the groups they administer are called out, not just the ones they are in', () => {
  const lines = removalConsequences({
    tier: 'admin',
    groups: [{ name: 'Selections', administers: true }, { name: 'Astro' }],
  });

  const administers = lines.find((line) => /administer Selections/.test(line));
  assert.ok(administers, 'the administered group is not mentioned');
  // Both facts are said: what they run, and what they merely belong to.
  assert.ok(lines.some((line) => line.includes('Selections and Astro')));
});
