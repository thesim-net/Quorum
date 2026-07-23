import test from 'node:test';
import assert from 'node:assert/strict';
import { normaliseAnswer, AnswerError } from './answers.js';

/**
 * Builds a question row for a test case.
 *
 * @param {string} type Question type.
 * @param {object} config Type-specific settings.
 * @param {boolean} required Whether the question must be answered.
 * @returns {object} Question row shaped like the database record.
 */
const q = (type, config = {}, required = true) => ({ type, config, required });

const OPTIONS = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];

test('a required question rejects a blank answer', () => {
  assert.throws(() => normaliseAnswer(q('short_text'), [], '   '), AnswerError);
  assert.throws(() => normaliseAnswer(q('multi_choice'), OPTIONS, []), AnswerError);
});

test('an optional question records a blank answer as skipped', () => {
  assert.deepEqual(normaliseAnswer(q('short_text', {}, false), [], ''), { skipped: true });
});

test('text answers are trimmed and length checked', () => {
  assert.deepEqual(normaliseAnswer(q('short_text', { maxLength: 10 }), [], '  hello  '), {
    text: 'hello',
  });
  assert.throws(
    () => normaliseAnswer(q('short_text', { maxLength: 3 }), [], 'toolong'),
    AnswerError,
  );
  assert.throws(
    () => normaliseAnswer(q('short_text', { minLength: 5 }), [], 'hi'),
    AnswerError,
  );
});

test('integer answers respect min, max and step', () => {
  const question = q('integer', { min: 0, max: 100, step: 5 });
  assert.deepEqual(normaliseAnswer(question, [], 25), { number: 25 });
  assert.deepEqual(normaliseAnswer(question, [], '30'), { number: 30 });
  assert.throws(() => normaliseAnswer(question, [], 101), AnswerError);
  assert.throws(() => normaliseAnswer(question, [], -1), AnswerError);
  assert.throws(() => normaliseAnswer(question, [], 7), AnswerError);
  assert.throws(() => normaliseAnswer(question, [], 2.5), AnswerError);
});

test('single choice rejects unknown options and honours allowOther', () => {
  assert.deepEqual(normaliseAnswer(q('single_choice'), OPTIONS, 'a'), {
    optionId: 'a',
    other: null,
  });
  assert.throws(() => normaliseAnswer(q('single_choice'), OPTIONS, 'zz'), AnswerError);

  // A custom answer needs the toggle enabled.
  assert.throws(
    () => normaliseAnswer(q('single_choice'), OPTIONS, { optionId: null, other: 'mine' }),
    AnswerError,
  );
  assert.deepEqual(
    normaliseAnswer(q('single_choice', { allowOther: true }), OPTIONS, {
      optionId: null,
      other: 'mine',
    }),
    { optionId: null, other: 'mine' },
  );
});

test('multi choice enforces selection counts and rejects duplicates', () => {
  const question = q('multi_choice', { minSelections: 2, maxSelections: 3 });
  assert.deepEqual(normaliseAnswer(question, OPTIONS, ['a', 'b']), {
    optionIds: ['a', 'b'],
    other: null,
  });
  assert.throws(() => normaliseAnswer(question, OPTIONS, ['a']), AnswerError);
  assert.throws(() => normaliseAnswer(question, OPTIONS, ['a', 'a']), AnswerError);
});

test('a custom answer counts toward the multi choice selection limit', () => {
  const question = q('multi_choice', { allowOther: true, maxSelections: 2 });
  assert.throws(
    () => normaliseAnswer(question, OPTIONS, { optionIds: ['a', 'b'], other: 'extra' }),
    AnswerError,
  );
});

test('ranking must order every option exactly once', () => {
  assert.deepEqual(normaliseAnswer(q('ranking'), OPTIONS, ['c', 'a', 'b']), {
    order: ['c', 'a', 'b'],
  });
  assert.throws(() => normaliseAnswer(q('ranking'), OPTIONS, ['a', 'b']), AnswerError);
  assert.throws(() => normaliseAnswer(q('ranking'), OPTIONS, ['a', 'b', 'b']), AnswerError);
});

test('whitespace counts toward the limit but is not an answer', () => {
  // Spaces occupy the cap, so a value over the limit is rejected as too long
  // even though trimming it would fit.
  assert.throws(
    () => normaliseAnswer(q('short_text', { maxLength: 5 }), [], 'hi     '),
    AnswerError,
  );

  // Spaces alone are empty: required rejects, optional records a skip.
  assert.throws(() => normaliseAnswer(q('short_text'), [], '     '), AnswerError);
  assert.throws(() => normaliseAnswer(q('long_text'), [], '\n\t  \n'), AnswerError);
  assert.deepEqual(normaliseAnswer(q('short_text', {}, false), [], '     '), { skipped: true });
});

test('a zero maximum on multi choice forbids every selection', () => {
  const question = q('multi_choice', { maxSelections: 0 }, false);
  assert.throws(() => normaliseAnswer(question, OPTIONS, ['a']), AnswerError);
  // Nothing selected is still a valid answer to an optional question.
  assert.deepEqual(normaliseAnswer(question, OPTIONS, []), { skipped: true });
});

test('a zero minimum on multi choice is not treated as absent', () => {
  const question = q('multi_choice', { minSelections: 0, maxSelections: 2 });
  assert.deepEqual(normaliseAnswer(question, OPTIONS, ['a']), {
    optionIds: ['a'],
    other: null,
  });
});

test('boolean accepts real booleans and their string forms', () => {
  assert.deepEqual(normaliseAnswer(q('boolean'), [], false), { bool: false });
  assert.deepEqual(normaliseAnswer(q('boolean'), [], 'true'), { bool: true });
  assert.throws(() => normaliseAnswer(q('boolean'), [], 'yes'), AnswerError);
});
