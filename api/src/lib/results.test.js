import test from 'node:test';
import assert from 'node:assert/strict';
import { categorise, aggregateRanking, numericStats, toCsv, csvField } from './results.js';

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
