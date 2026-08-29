/**
 * Answer filters, as carried in the URL.
 *
 * A filter is `questionId:categoryKey`, where the key is the same one the
 * results endpoint reports for a chart slice. Sharing that key space is what
 * guarantees a filter always names something the charts can actually count,
 * rather than a second, parallel idea of what an answer is.
 *
 * They live in the query string rather than in component state so a narrowed
 * shortlist can be linked, bookmarked and reached with the back button - which
 * is what makes "these are the eleven we should interview" something you can
 * send to somebody else.
 */

/**
 * Splits one filter into its question and answer halves.
 *
 * Only the FIRST colon separates them. A typed answer's key is `other:...`, so
 * splitting on every colon would corrupt precisely the answers people wrote
 * themselves.
 *
 * @param {string} raw The `questionId:categoryKey` pair.
 * @returns {{questionId: string, key: string}|null} Parsed, or null when
 *   malformed.
 */
export function parseFilter(raw) {
  const text = String(raw ?? '');
  const split = text.indexOf(':');
  if (split <= 0) return null;

  const questionId = text.slice(0, split);
  const key = text.slice(split + 1);
  return key ? { questionId, key } : null;
}

/**
 * Builds the filter string for one question and answer.
 *
 * @param {string} questionId
 * @param {string} key Category key.
 * @returns {string} The `questionId:categoryKey` pair.
 */
export const buildFilter = (questionId, key) => `${questionId}:${key}`;

/**
 * Whether a question offers a fixed set of answers worth filtering on.
 *
 * Free text has no set to choose from, so it is not offered as a filter rather
 * than offered and then found to be useless.
 *
 * @param {object} question A question from the results payload.
 * @returns {boolean} True when it can be filtered on.
 */
export const isFilterable = (question) =>
  Array.isArray(question?.offered) && question.offered.length > 0;

/**
 * Turns a filter into the words shown on its chip.
 *
 * @param {string} raw The filter string.
 * @param {Array<object>} questions Questions from the results payload.
 * @returns {{questionId: string, key: string, prompt: string, answer: string,
 *   known: boolean}|null} Display fields, or null when unparseable.
 */
export function describeFilter(raw, questions) {
  const parsed = parseFilter(raw);
  if (!parsed) return null;

  const question = (questions ?? []).find((entry) => entry.id === parsed.questionId) ?? null;
  const offered = question?.offered?.find((entry) => entry.key === parsed.key) ?? null;

  return {
    ...parsed,
    prompt: question?.prompt ?? 'Question no longer in this survey',
    // A filter outlives the option it names when a survey is edited, or when an
    // old link is opened. Saying so beats rendering a bare uuid.
    answer: offered?.label ?? 'Answer no longer offered',
    known: Boolean(question && offered),
  };
}

/**
 * Adds or removes one filter, treating the list as a set.
 *
 * Toggling rather than appending keeps a chip and the control that created it
 * in agreement, and makes the same click undo itself.
 *
 * @param {string[]} filters Current filters.
 * @param {string} filter The one to toggle.
 * @returns {string[]} The new list.
 */
export const toggleFilter = (filters, filter) =>
  filters.includes(filter) ? filters.filter((entry) => entry !== filter) : [...filters, filter];
