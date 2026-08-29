import test from 'node:test';
import assert from 'node:assert/strict';
import { duration, truncate, when } from './format.js';

test('text shorter than the limit is left alone', () => {
  assert.equal(truncate('What is your sex?', 90), 'What is your sex?');
});

test('longer text is cut and marked, never exceeding the limit', () => {
  // A select sizes itself to its widest option, so the cap has to be a cap -
  // one survey prompt here is a full paragraph.
  const long = 'a'.repeat(300);
  const out = truncate(long, 90);
  assert.equal(out.length, 90);
  assert.ok(out.endsWith('...'));
});

test('trailing space before the ellipsis is dropped', () => {
  assert.equal(truncate('ab cdefghij', 6), 'ab...');
});

test('the ellipsis is inside the budget, not added to it', () => {
  // The cap exists to fit a control, so overshooting it by three would defeat
  // the point.
  for (const max of [6, 20, 44, 90]) {
    assert.ok(truncate('x'.repeat(500), max).length <= max, `max ${max}`);
  }
});

test('missing text truncates to nothing rather than "null"', () => {
  assert.equal(truncate(null, 10), '');
  assert.equal(truncate(undefined, 10), '');
});

test('durations read in the largest sensible unit', () => {
  assert.equal(duration(null), '-');
  assert.equal(duration(0), '0s');
  assert.equal(duration(45_000), '45s');
  assert.equal(duration(125_000), '2m 5s');
  assert.equal(duration(3_725_000), '1h 2m');
});

test('an unreadable timestamp shows a dash rather than "Invalid Date"', () => {
  assert.equal(when(null), '-');
  assert.equal(when('not a date'), '-');
});
