import test from 'node:test';
import assert from 'node:assert/strict';
import { collapseEvents, totalDuration, MAX_INTERVAL_MS } from './timing.js';

/**
 * Builds an event at a whole-second offset from a fixed origin.
 *
 * @param {string|null} questionId Question the participant was on.
 * @param {number} seconds Offset from the origin.
 * @returns {{question_id: string|null, at: Date}} Event row.
 */
const at = (questionId, seconds) => ({
  question_id: questionId,
  at: new Date(Date.UTC(2026, 0, 1, 0, 0, seconds)),
});

test('time is credited to the question the participant was on', () => {
  const totals = collapseEvents([at('q1', 0), at('q2', 10), at('q3', 25), at(null, 30)]);

  assert.equal(totals.get('q1'), 10_000);
  assert.equal(totals.get('q2'), 15_000);
  assert.equal(totals.get('q3'), 5_000);
});

test('revisiting a question accumulates rather than overwrites', () => {
  const totals = collapseEvents([
    at('q1', 0),
    at('q2', 10),
    at('q1', 15),
    at('q2', 20),
    at(null, 22),
  ]);

  assert.equal(totals.get('q1'), 15_000);
  assert.equal(totals.get('q2'), 7_000);
});

test('an idle stretch is capped rather than counted in full', () => {
  const totals = collapseEvents([at('q1', 0), at('q2', 7200), at(null, 7205)]);

  assert.equal(totals.get('q1'), MAX_INTERVAL_MS);
});

test('the trailing event contributes no time of its own', () => {
  const totals = collapseEvents([at('q1', 0)]);
  assert.equal(totals.size, 0);
});

test('total duration sums the capped per-question intervals', () => {
  const totals = collapseEvents([at('q1', 0), at('q2', 10), at(null, 40)]);
  assert.equal(totalDuration(totals), 40_000);
});
