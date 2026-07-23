/**
 * Result aggregation.
 *
 * Turns raw answers into the chart-ready shapes the admin panel renders, and
 * into flat rows for CSV/JSON export.
 */

/**
 * Resolves the label for one side of a true/false question.
 *
 * Custom labels are optional, and a blank one is not a label - it falls back to
 * True/False so a chart or export never shows an unnamed category.
 *
 * @param {object} config Question config.
 * @param {boolean} side Which side to label.
 * @returns {string} The label.
 */
export function booleanLabel(config, side) {
  const custom = side ? config?.trueLabel : config?.falseLabel;
  const trimmed = typeof custom === 'string' ? custom.trim() : '';
  return trimmed || (side ? 'True' : 'False');
}

/**
 * Buckets a set of answers into labelled categories with counts.
 *
 * Free-text answers and custom "other" answers each become their own category,
 * grouped case-insensitively so "Yes" and "yes" do not split a slice.
 *
 * @param {object} question Question row.
 * @param {Array<{id: string, label: string}>} options The question's options.
 * @param {Array<{value: object}>} answers Answers to this question.
 * @returns {{categories: Array<{key: string, label: string, count: number,
 *   custom: boolean}>, answered: number, skipped: number}} Category counts plus
 *   participation totals.
 */
export function categorise(question, options, answers) {
  const labels = new Map(options.map((option) => [option.id, option.label]));
  const counts = new Map();
  let answered = 0;
  let skipped = 0;

  /**
   * Records one occurrence of a category.
   *
   * @param {string} key Stable identifier used to merge equal answers.
   * @param {string} label Display label.
   * @param {boolean} custom Whether this came from free text rather than a preset option.
   */
  const add = (key, label, custom = false) => {
    const existing = counts.get(key);
    if (existing) existing.count += 1;
    else counts.set(key, { key, label, count: 1, custom });
  };

  for (const { value } of answers) {
    if (value?.skipped) {
      skipped += 1;
      continue;
    }
    answered += 1;

    switch (question.type) {
      case 'single_choice':
        if (value.optionId) add(value.optionId, labels.get(value.optionId) ?? 'Deleted option');
        if (value.other) add(`other:${value.other.toLowerCase()}`, value.other, true);
        break;

      case 'multi_choice':
        for (const id of value.optionIds ?? []) {
          add(id, labels.get(id) ?? 'Deleted option');
        }
        if (value.other) add(`other:${value.other.toLowerCase()}`, value.other, true);
        break;

      case 'boolean':
        add(String(value.bool), booleanLabel(question.config, value.bool));
        break;

      case 'integer':
      case 'scale':
        add(String(value.number), String(value.number));
        break;

      case 'short_text':
      case 'long_text':
        add(`text:${value.text.toLowerCase()}`, value.text, true);
        break;

      default:
        break;
    }
  }

  const categories = [...counts.values()].sort(
    (a, b) => b.count - a.count || a.label.localeCompare(b.label),
  );
  return { categories, answered, skipped };
}

/**
 * Averages each option's rank across every response to a ranking question.
 *
 * @param {Array<{id: string, label: string}>} options The question's options.
 * @param {Array<{value: object}>} answers Answers to this question.
 * @returns {{ranking: Array<{key: string, label: string, averageRank: number,
 *   firstChoices: number}>, answered: number, skipped: number}} Options ordered
 *   best-ranked first.
 */
export function aggregateRanking(options, answers) {
  const totals = new Map(options.map((o) => [o.id, { sum: 0, n: 0, first: 0 }]));
  let answered = 0;
  let skipped = 0;

  for (const { value } of answers) {
    if (value?.skipped || !Array.isArray(value?.order)) {
      skipped += 1;
      continue;
    }
    answered += 1;

    value.order.forEach((optionId, index) => {
      const entry = totals.get(optionId);
      if (!entry) return;
      entry.sum += index + 1;
      entry.n += 1;
      if (index === 0) entry.first += 1;
    });
  }

  const ranking = options
    .map((option) => {
      const entry = totals.get(option.id);
      return {
        key: option.id,
        label: option.label,
        averageRank: entry.n ? entry.sum / entry.n : null,
        firstChoices: entry.first,
      };
    })
    .sort((a, b) => (a.averageRank ?? Infinity) - (b.averageRank ?? Infinity));

  return { ranking, answered, skipped };
}

/**
 * Summary statistics for a numeric question.
 *
 * @param {Array<{value: object}>} answers Answers to this question.
 * @returns {{min: number, max: number, mean: number, median: number}|null}
 *   Statistics, or null when nothing was answered.
 */
export function numericStats(answers) {
  const numbers = answers
    .filter((a) => !a.value?.skipped && typeof a.value?.number === 'number')
    .map((a) => a.value.number)
    .sort((a, b) => a - b);

  if (numbers.length === 0) return null;

  const sum = numbers.reduce((total, n) => total + n, 0);
  const mid = Math.floor(numbers.length / 2);

  return {
    min: numbers[0],
    max: numbers[numbers.length - 1],
    mean: sum / numbers.length,
    median: numbers.length % 2 ? numbers[mid] : (numbers[mid - 1] + numbers[mid]) / 2,
  };
}

/**
 * Renders a value in the canonical shape used by CSV and JSON export.
 *
 * @param {object} question Question row.
 * @param {Map<string, string>} optionLabels Option id -> label.
 * @param {object|null} value An `answers.value` payload.
 * @returns {string} Human-readable representation, empty when unanswered.
 */
export function formatAnswer(question, optionLabels, value) {
  if (!value || value.skipped) return '';

  switch (question.type) {
    case 'short_text':
    case 'long_text':
      return value.text ?? '';
    case 'integer':
    case 'scale':
      return String(value.number ?? '');
    case 'boolean':
      return booleanLabel(question.config, value.bool);
    case 'single_choice':
      return value.optionId ? optionLabels.get(value.optionId) ?? '' : value.other ?? '';
    case 'multi_choice': {
      const chosen = (value.optionIds ?? []).map((id) => optionLabels.get(id) ?? '');
      if (value.other) chosen.push(value.other);
      return chosen.join('; ');
    }
    case 'ranking':
      return (value.order ?? []).map((id, i) => `${i + 1}. ${optionLabels.get(id) ?? ''}`).join('; ');
    case 'file_upload':
      return value.filename ?? (value.fileId ? 'file' : '');
    default:
      return '';
  }
}

/**
 * Escapes one CSV field.
 *
 * A leading =, +, - or @ is prefixed with a quote so spreadsheet software does
 * not execute a participant's answer as a formula.
 *
 * @param {*} field Raw field value.
 * @returns {string} Quoted, escaped field.
 */
export function csvField(field) {
  const text = field === null || field === undefined ? '' : String(field);
  const guarded = /^[=+\-@]/.test(text) ? `'${text}` : text;
  return `"${guarded.replace(/"/g, '""')}"`;
}

/**
 * Serialises rows to CSV text.
 *
 * @param {string[]} headers Column headers.
 * @param {Array<Array<*>>} rows Row values, aligned to `headers`.
 * @returns {string} CSV document with CRLF line endings.
 */
export function toCsv(headers, rows) {
  const lines = [headers.map(csvField).join(',')];
  for (const row of rows) lines.push(row.map(csvField).join(','));
  return lines.join('\r\n');
}
