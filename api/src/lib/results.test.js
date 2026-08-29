import test from 'node:test';
import assert from 'node:assert/strict';
import {
  answerCategories,
  answerMatches,
  categorise,
  aggregateRanking,
  numericStats,
  offeredAnswers,
  toCsv,
  csvField,
} from './results.js';

const OPTIONS = [
  { id: 'a', label: 'Alpha' },
  { id: 'b', label: 'Beta' },
];

/**
 * Wraps raw values as answer rows.
 *
 * @param {Array<object>} values `answers.value` payloads.
 * @returns {Array<{value: object}>} Answer rows.
 */
const answers = (values) => values.map((value) => ({ value }));

test('single choice counts options and keeps custom answers separate', () => {
  const question = { type: 'single_choice', config: {} };
  const { categories, answered, skipped } = categorise(
    question,
    OPTIONS,
    answers([
      { optionId: 'a', other: null },
      { optionId: 'a', other: null },
      { optionId: 'b', other: null },
      { optionId: null, other: 'Gamma' },
      { skipped: true },
    ]),
  );

  assert.equal(answered, 4);
  assert.equal(skipped, 1);
  assert.deepEqual(
    categories.map((c) => [c.label, c.count, c.custom]),
    [
      ['Alpha', 2, false],
      ['Beta', 1, false],
      ['Gamma', 1, true],
    ],
  );
});

test('equal free-text answers merge case-insensitively into one category', () => {
  const { categories } = categorise(
    { type: 'short_text', config: {} },
    [],
    answers([{ text: 'Pizza' }, { text: 'pizza' }, { text: 'Tacos' }]),
  );

  assert.deepEqual(
    categories.map((c) => [c.label, c.count]),
    [
      ['Pizza', 2],
      ['Tacos', 1],
    ],
  );
});

test('multi choice counts every selection, so counts exceed respondents', () => {
  const { categories, answered } = categorise(
    { type: 'multi_choice', config: {} },
    OPTIONS,
    answers([{ optionIds: ['a', 'b'] }, { optionIds: ['a'] }]),
  );

  assert.equal(answered, 2);
  assert.equal(categories.find((c) => c.label === 'Alpha').count, 2);
  assert.equal(categories.find((c) => c.label === 'Beta').count, 1);
});

test('boolean categories use the question labels', () => {
  const { categories } = categorise(
    { type: 'boolean', config: { trueLabel: 'Yes', falseLabel: 'No' } },
    [],
    answers([{ bool: true }, { bool: false }, { bool: true }]),
  );

  assert.deepEqual(
    categories.map((c) => [c.label, c.count]),
    [
      ['Yes', 2],
      ['No', 1],
    ],
  );
});

test('blank boolean labels fall back to True and False', () => {
  for (const config of [{}, { trueLabel: '', falseLabel: '' }, { trueLabel: '   ' }]) {
    const { categories } = categorise({ type: 'boolean', config }, [], answers([{ bool: true }]));
    assert.equal(categories[0].label, 'True', `config ${JSON.stringify(config)}`);
  }

  const { categories } = categorise(
    { type: 'boolean', config: { trueLabel: 'Yes' } },
    [],
    answers([{ bool: true }, { bool: false }]),
  );
  // A custom label on one side leaves the other at its default.
  assert.deepEqual(categories.map((c) => c.label).sort(), ['False', 'Yes']);
});

test('ranking orders options by average position', () => {
  const { ranking, answered } = aggregateRanking(
    OPTIONS,
    answers([{ order: ['b', 'a'] }, { order: ['b', 'a'] }, { order: ['a', 'b'] }]),
  );

  assert.equal(answered, 3);
  assert.equal(ranking[0].label, 'Beta');
  assert.equal(ranking[0].firstChoices, 2);
  assert.ok(Math.abs(ranking[0].averageRank - 4 / 3) < 1e-9);
});

test('numeric stats cover the empty case', () => {
  assert.equal(numericStats(answers([{ skipped: true }])), null);

  const stats = numericStats(answers([{ number: 5 }, { number: 1 }, { number: 3 }]));
  assert.deepEqual(stats, { min: 1, max: 5, mean: 3, median: 3 });
});

test('csv fields are quoted and formula-guarded', () => {
  assert.equal(csvField('plain'), '"plain"');
  assert.equal(csvField('say "hi"'), '"say ""hi"""');
  assert.equal(csvField('=cmd|calc'), '"\'=cmd|calc"');
  assert.equal(csvField(null), '""');
});

test('csv rows line up with their headers', () => {
  const csv = toCsv(['a', 'b'], [[1, 'x'], [2, 'y']]);
  assert.equal(csv, '"a","b"\r\n"1","x"\r\n"2","y"');
});

const LABELS = new Map(OPTIONS.map((o) => [o.id, o.label]));

test('a filter matches exactly the people a slice counted', () => {
  // The property that matters: anything answerCategories buckets under a key,
  // answerMatches agrees is that key. If these two ever drift, "show me
  // everyone who picked Alpha" silently returns a different set from the
  // number printed on the Alpha slice.
  const question = { type: 'single_choice', config: {} };
  const values = [
    { optionId: 'a', other: null },
    { optionId: 'b', other: null },
    { optionId: null, other: 'Gamma' },
    { skipped: true },
  ];

  for (const value of values) {
    for (const category of answerCategories(question, LABELS, value)) {
      assert.equal(answerMatches(question, LABELS, value, category.key), true);
    }
  }

  const { categories } = categorise(question, OPTIONS, answers(values));
  for (const category of categories) {
    const matched = values.filter((v) => answerMatches(question, LABELS, v, category.key)).length;
    assert.equal(matched, category.count, `${category.label} disagreed`);
  }
});

test('a multi-choice answer matches every option it selected', () => {
  const question = { type: 'multi_choice', config: {} };
  const value = { optionIds: ['a', 'b'], other: null };
  assert.equal(answerMatches(question, LABELS, value, 'a'), true);
  assert.equal(answerMatches(question, LABELS, value, 'b'), true);
  assert.equal(answerMatches(question, LABELS, value, 'c'), false);
});

test('a skipped answer matches nothing at all', () => {
  const question = { type: 'single_choice', config: {} };
  assert.deepEqual(answerCategories(question, LABELS, { skipped: true }), []);
  assert.equal(answerMatches(question, LABELS, { skipped: true }, 'a'), false);
});

test('a text answer with no text is not a category and does not throw', () => {
  const question = { type: 'short_text', config: {} };
  assert.deepEqual(answerCategories(question, LABELS, { text: null }), []);
  assert.deepEqual(answerCategories(question, LABELS, {}), []);
});

test('offered answers include the options nobody picked', () => {
  // The reason this exists. Alpha was chosen, Beta was not, and Beta has to be
  // visible as a zero rather than absent - "nobody chose this" is a finding.
  const question = { type: 'single_choice', config: {} };
  const { categories } = categorise(question, OPTIONS, answers([{ optionId: 'a', other: null }]));

  assert.deepEqual(
    offeredAnswers(question, OPTIONS, categories).map((o) => [o.label, o.count]),
    [
      ['Alpha', 1],
      ['Beta', 0],
    ],
  );
});

test('offered answers keep the order the question presents them in', () => {
  // Not sorted by count: a candidate reads the options in the order they were
  // asked, so the breakdown has to line up with the question.
  const question = { type: 'single_choice', config: {} };
  const { categories } = categorise(
    question,
    OPTIONS,
    answers([{ optionId: 'b' }, { optionId: 'b' }, { optionId: 'a' }]),
  );
  assert.deepEqual(
    offeredAnswers(question, OPTIONS, categories).map((o) => o.label),
    ['Alpha', 'Beta'],
  );
});

test('offered answers cover both sides of a boolean and the whole scale', () => {
  const boolean = { type: 'boolean', config: { trueLabel: 'Agree', falseLabel: 'Disagree' } };
  assert.deepEqual(
    offeredAnswers(boolean, [], categorise(boolean, [], answers([{ bool: true }])).categories).map(
      (o) => [o.label, o.count],
    ),
    [
      ['Agree', 1],
      ['Disagree', 0],
    ],
  );

  const scale = { type: 'scale', config: { min: 1, max: 5 } };
  assert.deepEqual(
    offeredAnswers(scale, [], categorise(scale, [], answers([{ number: 2 }])).categories).map(
      (o) => [o.label, o.count],
    ),
    [
      ['1', 0],
      ['2', 1],
      ['3', 0],
      ['4', 0],
      ['5', 0],
    ],
  );
});

test('free text and files have no set of offered answers to enumerate', () => {
  assert.equal(offeredAnswers({ type: 'long_text', config: {} }, [], []), null);
  assert.equal(offeredAnswers({ type: 'file_upload', config: {} }, [], []), null);
});

test('a broken scale range enumerates nothing rather than running away', () => {
  assert.equal(offeredAnswers({ type: 'scale', config: { min: 5, max: 1 } }, [], []), null);
  assert.equal(offeredAnswers({ type: 'scale', config: { min: 0, max: 1e9 } }, [], []), null);
});
