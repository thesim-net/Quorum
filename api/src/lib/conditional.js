/**
 * Conditional question visibility.
 *
 * A question may carry `config.showIf = { questionId, equals }`. It is shown
 * only when the referenced question's answer matches. The same rule is
 * evaluated on the client (to drive navigation) and on the server (so a hidden
 * required question is never enforced), which is why it lives here in one place.
 */

/**
 * Whether an answer to the controlling question matches the expected value.
 *
 * `equals` is compared against the natural value of each answer type: an option
 * id for single choice, the boolean for true/false, membership for multi
 * choice, or the string form for text and numbers.
 *
 * @param {object|null|undefined} value An `answers.value` payload.
 * @param {*} expected The value the condition looks for.
 * @returns {boolean} True when the answer satisfies the condition.
 */
function answerMatches(value, expected) {
  if (!value || value.skipped) return false;

  if (typeof value.optionId === 'string') return value.optionId === expected;
  if (Array.isArray(value.optionIds)) return value.optionIds.includes(expected);
  if (typeof value.bool === 'boolean') return String(value.bool) === String(expected);
  if (typeof value.number === 'number') return String(value.number) === String(expected);
  if (typeof value.text === 'string') return value.text === expected;
  return false;
}

/**
 * Whether a question is visible given the current answers.
 *
 * A missing or malformed condition means always visible, so a survey without
 * conditional logic behaves exactly as before.
 *
 * @param {object} question Question row with `config`.
 * @param {Map<string, object>|Record<string, object>} answers Answers keyed by
 *   question id.
 * @returns {boolean} True when the question should be shown and enforced.
 */
export function isQuestionVisible(question, answers) {
  const condition = question.config?.showIf;
  if (!condition || !condition.questionId) return true;

  const lookup = answers instanceof Map ? answers.get(condition.questionId) : answers[condition.questionId];
  return answerMatches(lookup, condition.equals);
}

/**
 * Filters a question list down to those currently visible.
 *
 * @param {object[]} questions All questions, in order.
 * @param {Map<string, object>|Record<string, object>} answers Current answers.
 * @returns {object[]} The visible subset, order preserved.
 */
export function visibleQuestions(questions, answers) {
  return questions.filter((question) => isQuestionVisible(question, answers));
}
