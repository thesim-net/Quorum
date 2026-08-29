import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildFilter,
  describeFilter,
  isFilterable,
  parseFilter,
  toggleFilter,
} from './answerFilters.js';

const QUESTION_ID = '11111111-1111-4111-8111-111111111111';

const QUESTIONS = [
  {
    id: QUESTION_ID,
    prompt: 'What would you do?',
    offered: [
      { key: 'opt-a', label: 'Escalate to the admin team', count: 3 },
      { key: 'opt-b', label: 'Ignore it', count: 0 },
    ],
  },
  { id: '22222222-2222-4222-8222-222222222222', prompt: 'Why?', offered: null },
];

test('a filter splits on the first colon only', () => {
  // The case that matters: a typed answer's key contains a colon of its own,
  // and splitting on all of them would corrupt every custom answer.
  assert.deepEqual(parseFilter(`${QUESTION_ID}:other:some thing`), {
    questionId: QUESTION_ID,
    key: 'other:some thing',
  });
});

test('a filter round-trips through build and parse', () => {
  const built = buildFilter(QUESTION_ID, 'other:a:b:c');
  assert.deepEqual(parseFilter(built), { questionId: QUESTION_ID, key: 'other:a:b:c' });
});

test('malformed filters parse to nothing rather than half a filter', () => {
  assert.equal(parseFilter(''), null);
  assert.equal(parseFilter('no-colon'), null);
  assert.equal(parseFilter(':leading'), null);
  assert.equal(parseFilter(`${QUESTION_ID}:`), null);
  assert.equal(parseFilter(undefined), null);
});

test('only questions with a fixed set of answers are filterable', () => {
  assert.equal(isFilterable(QUESTIONS[0]), true);
  assert.equal(isFilterable(QUESTIONS[1]), false);
  assert.equal(isFilterable({ offered: [] }), false);
  assert.equal(isFilterable(undefined), false);
});

test('a filter describes itself with the question and answer wording', () => {
  const described = describeFilter(buildFilter(QUESTION_ID, 'opt-b'), QUESTIONS);
  assert.equal(described.prompt, 'What would you do?');
  assert.equal(described.answer, 'Ignore it');
  assert.equal(described.known, true);
});

test('an option nobody picked is still filterable and still named', () => {
  // Filtering to a zero-count answer is a legitimate question - "did anyone
  // choose this" - and must not render as an unknown option.
  const described = describeFilter(buildFilter(QUESTION_ID, 'opt-b'), QUESTIONS);
  assert.equal(described.known, true);
  assert.equal(described.answer, 'Ignore it');
});

test('a filter naming something the survey no longer has says so', () => {
  const gone = describeFilter(buildFilter(QUESTION_ID, 'deleted-option'), QUESTIONS);
  assert.equal(gone.known, false);
  assert.equal(gone.answer, 'Answer no longer offered');

  const orphan = describeFilter('33333333-3333-4333-8333-333333333333:x', QUESTIONS);
  assert.equal(orphan.known, false);
  assert.equal(orphan.prompt, 'Question no longer in this survey');
});

test('toggling adds a filter and the same toggle removes it', () => {
  const one = buildFilter(QUESTION_ID, 'opt-a');
  const two = buildFilter(QUESTION_ID, 'opt-b');

  assert.deepEqual(toggleFilter([], one), [one]);
  assert.deepEqual(toggleFilter([one], two), [one, two]);
  assert.deepEqual(toggleFilter([one, two], one), [two]);
});

test('toggling never duplicates a filter already applied', () => {
  const one = buildFilter(QUESTION_ID, 'opt-a');
  assert.deepEqual(toggleFilter(toggleFilter([one], one), one), [one]);
});
