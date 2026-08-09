import test from 'node:test';
import assert from 'node:assert/strict';
import {
  START,
  allowsRepeat,
  currentAttempt,
  oneResponsePerPerson,
  startAction,
} from './responsePolicy.js';

/**
 * Builds a survey row.
 *
 * @param {object} fields Overrides.
 * @returns {object} Survey row.
 */
const survey = (fields = {}) => ({
  require_guild: false,
  one_response_per_person: true,
  allow_response_edits: false,
  ...fields,
});

/**
 * Builds a response row.
 *
 * @param {string} status
 * @param {object} fields Overrides.
 * @returns {object} Response row.
 */
const response = (status, fields = {}) => ({
  id: `response-${Math.random().toString(36).slice(2, 8)}`,
  status,
  started_at: '2026-01-01T10:00:00Z',
  completed_at: status === 'completed' ? '2026-01-01T10:05:00Z' : null,
  ...fields,
});

test('a survey holds each person to one response unless it says otherwise', () => {
  // The column defaults to true, and a row from before it existed reads the
  // same way, so nothing silently starts accepting repeats.
  assert.equal(oneResponsePerPerson(survey()), true);
  assert.equal(oneResponsePerPerson({}), true);
  assert.equal(allowsRepeat(survey()), false);

  assert.equal(oneResponsePerPerson(survey({ one_response_per_person: false })), false);
  assert.equal(allowsRepeat(survey({ one_response_per_person: false })), true);
});

test('one response per person turns a returning respondent away', () => {
  assert.equal(startAction(survey(), response('completed')), START.REFUSE);
});

test('allowing repeats hands a returning respondent a fresh response', () => {
  const repeatable = survey({ one_response_per_person: false });
  assert.equal(startAction(repeatable, response('completed')), START.CREATE);
});

test('an unfinished response is always resumed rather than duplicated', () => {
  assert.equal(startAction(survey(), response('in_progress')), START.RESUME);
  assert.equal(
    startAction(survey({ one_response_per_person: false }), response('in_progress')),
    START.RESUME,
  );
});

test('a first-time respondent always gets a response created', () => {
  assert.equal(startAction(survey(), null), START.CREATE);
  assert.equal(startAction(survey({ one_response_per_person: false }), null), START.CREATE);
});

test('the limit reads the same on a gated survey as on an anonymous one', () => {
  // Who the respondent is has nothing to do with how many times they may
  // answer: the two settings are decided separately and evaluated separately.
  for (const requireGuild of [false, true]) {
    assert.equal(
      startAction(survey({ require_guild: requireGuild }), response('completed')),
      START.REFUSE,
    );
    assert.equal(
      startAction(
        survey({ require_guild: requireGuild, one_response_per_person: false }),
        response('completed'),
      ),
      START.CREATE,
    );
  }
});

test('allowing edits reopens the response already given, with or without repeats', () => {
  assert.equal(
    startAction(survey({ allow_response_edits: true }), response('completed')),
    START.RESUME,
  );
  assert.equal(
    startAction(
      survey({ one_response_per_person: false, allow_response_edits: true }),
      response('completed'),
    ),
    START.RESUME,
  );
});

test('with several responses to choose from, editing means the most recent one', () => {
  const first = response('completed', { id: 'first', completed_at: '2026-01-01T10:05:00Z' });
  const second = response('completed', { id: 'second', completed_at: '2026-02-01T09:00:00Z' });
  const third = response('completed', { id: 'third', completed_at: '2026-01-15T09:00:00Z' });

  // Order out of the database is not order of submission, so the choice is made
  // here rather than by whichever row came back first.
  assert.equal(currentAttempt([first, second, third]).id, 'second');
  assert.equal(currentAttempt([third, first, second]).id, 'second');
});

test('an attempt still in progress outranks anything already submitted', () => {
  const done = response('completed', { id: 'done', completed_at: '2026-03-01T09:00:00Z' });
  const open = response('in_progress', { id: 'open', started_at: '2026-01-01T09:00:00Z' });

  assert.equal(currentAttempt([done, open]).id, 'open');
});

test('one response, or none, is answered without ceremony', () => {
  assert.equal(currentAttempt([]), null);
  assert.equal(currentAttempt(), null);

  const only = response('completed', { id: 'only' });
  assert.equal(currentAttempt([only]).id, 'only');
});
