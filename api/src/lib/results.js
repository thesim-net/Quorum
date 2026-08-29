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
 * The categories one answer falls into.
 *
 * The single definition of "what does this answer count as", so that a chart
 * slice, a filter and a per-question breakdown can never disagree about it. A
 * multi-choice answer belongs to several categories at once; a skipped one to
 * none.
 *
 * Keys are stable identifiers rather than labels: an option id for a preset
 * choice, and a prefixed, lowercased form for anything a participant typed, so
 * that "Yes" and "yes" merge and a custom answer can never collide with an
 * option id.
 *
 * @param {object} question Question row.
 * @param {Map<string, string>} labels Option id to label.
 * @param {object} value The stored jsonb answer value.
 * @returns {Array<{key: string, label: string, custom: boolean}>} Categories,
 *   empty when the answer was skipped or carries nothing to count.
 */
export function answerCategories(question, labels, value) {
  if (!value || value.skipped) return [];

  const preset = (id) => ({
    key: id,
    label: labels.get(id) ?? 'Deleted option',
    custom: false,
  });
  const typed = (prefix, text) => ({
    key: `${prefix}:${text.toLowerCase()}`,
    label: text,
    custom: true,
  });

  switch (question.type) {
    case 'single_choice': {
      const out = [];
      if (value.optionId) out.push(preset(value.optionId));
      if (value.other) out.push(typed('other', value.other));
      return out;
    }

    case 'multi_choice': {
      const out = (value.optionIds ?? []).map(preset);
      if (value.other) out.push(typed('other', value.other));
      return out;
    }

    case 'boolean':
      return [
        { key: String(value.bool), label: booleanLabel(question.config, value.bool), custom: false },
      ];

    case 'integer':
    case 'scale':
      return [{ key: String(value.number), label: String(value.number), custom: false }];

    case 'short_text':
    case 'long_text':
      // Guarded: an answer row with no text is not a category, and reading
      // `.toLowerCase()` off nothing would take the whole results page down.
      return value.text ? [typed('text', value.text)] : [];

    // A ranking is an ordering rather than a choice. It has its own aggregate.
    default:
      return [];
  }
}

/**
 * Whether one answer falls into a given category.
 *
 * Defined in terms of `answerCategories` rather than repeating its rules, which
 * is what makes "filter to everyone who picked this" return exactly the people
 * the slice counted.
 *
 * @param {object} question Question row.
 * @param {Map<string, string>} labels Option id to label.
 * @param {object} value The stored jsonb answer value.
 * @param {string} key The category key being filtered on.
 * @returns {boolean} True when this answer counts towards that category.
 */
export const answerMatches = (question, labels, value, key) =>
  answerCategories(question, labels, value).some((category) => category.key === key);

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

  for (const { value } of answers) {
    if (value?.skipped) {
      skipped += 1;
      continue;
    }
    answered += 1;

    for (const category of answerCategories(question, labels, value)) {
      const existing = counts.get(category.key);
      if (existing) existing.count += 1;
      else counts.set(category.key, { ...category, count: 1 });
    }
  }

  const categories = [...counts.values()].sort(
    (a, b) => b.count - a.count || a.label.localeCompare(b.label),
  );
  return { categories, answered, skipped };
}

/**
 * Every answer a question OFFERS, with how many people chose each.
 *
 * `categorise` counts what was said; this lists what could have been said. The
 * difference is the whole point: an option nobody picked never appears in the
 * counts at all, so a question where no candidate chose the right answer looks
 * from the chart exactly like a question where nobody was asked. Zero is a
 * result, and it takes the full option list to show one.
 *
 * Returns null for questions with no fixed set of answers - free text and file
 * uploads have nothing to enumerate.
 *
 * @param {object} question Question row, including `config`.
 * @param {Array<{id: string, label: string}>} options The question's options.
 * @param {Array<{key: string, count: number}>} categories Output of `categorise`.
 * @returns {Array<{key: string, label: string, count: number}>|null} Every
 *   offered answer in the order it is presented, or null when there is no set.
 */
export function offeredAnswers(question, options, categories) {
  const counts = new Map(categories.map((category) => [category.key, category.count]));
  const at = (key) => counts.get(key) ?? 0;

  switch (question.type) {
    case 'single_choice':
    case 'multi_choice':
      return options.map((option) => ({
        key: option.id,
        label: option.label,
        count: at(option.id),
      }));

    case 'boolean':
      return [true, false].map((side) => ({
        key: String(side),
        label: booleanLabel(question.config, side),
        count: at(String(side)),
      }));

    case 'scale': {
      const min = Number(question.config?.min ?? 1);
      const max = Number(question.config?.max ?? 5);
      const step = Number(question.config?.step) || 1;
      // A scale with a broken or inverted range is a configuration problem, not
      // something to enumerate into a runaway list.
      if (!Number.isFinite(min) || !Number.isFinite(max) || max < min) return null;
      if ((max - min) / step > 100) return null;

      const out = [];
      for (let value = min; value <= max; value += step) {
        out.push({ key: String(value), label: String(value), count: at(String(value)) });
      }
      return out;
    }

    default:
      return null;
  }
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
