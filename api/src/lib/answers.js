/**
 * Answer validation and normalisation.
 *
 * Every submitted answer passes through here before it reaches the database, so
 * `answers.value` always holds the canonical shape documented in the schema and
 * reporting code never has to defend against malformed payloads.
 */

export class AnswerError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AnswerError';
  }
}

/** Defaults applied when a question's config omits a bound. */
const LIMITS = {
  short_text: { maxLength: 200, hardMax: 1000 },
  long_text: { maxLength: 2000, hardMax: 10000 },
  other_text: { maxLength: 200 },
};

/**
 * Whether a raw submitted value counts as "left blank".
 *
 * @param {*} raw Value as received from the client.
 * @returns {boolean} True when the participant supplied nothing.
 */
function isBlank(raw) {
  if (raw === null || raw === undefined) return true;
  if (typeof raw === 'string') return raw.trim() === '';
  if (Array.isArray(raw)) return raw.length === 0;
  if (typeof raw === 'object') {
    return Object.values(raw).every((value) => isBlank(value));
  }
  return false;
}

/**
 * Validates a free-text answer.
 *
 * @param {object} question Question row, including `config`.
 * @param {*} raw Submitted value.
 * @returns {{text: string}} Normalised answer.
 */
function normaliseText(question, raw) {
  const text = typeof raw === 'string' ? raw : raw?.text;
  if (typeof text !== 'string') throw new AnswerError('Expected a text answer.');

  const limits = LIMITS[question.type];
  const min = Number(question.config.minLength ?? 0);
  const max = Math.min(Number(question.config.maxLength ?? limits.maxLength), limits.hardMax);

  // The cap applies to what was typed, whitespace included, so the counter the
  // participant watched matches what the server enforces.
  if (text.length > max) {
    throw new AnswerError(`Answer must be at most ${max} characters.`);
  }

  const trimmed = text.trim();

  // Whitespace occupies the limit but is not an answer. A field holding only
  // spaces is empty, and `isBlank` has already let it through as "skipped"
  // when the question is optional - so reaching here means it was required.
  if (trimmed.length === 0) {
    throw new AnswerError('This question is required.');
  }
  if (trimmed.length < min) {
    throw new AnswerError(`Answer must be at least ${min} characters.`);
  }
  return { text: trimmed };
}

/**
 * Validates a numeric answer for integer and scale questions.
 *
 * @param {object} question Question row, including `config`.
 * @param {*} raw Submitted value.
 * @returns {{number: number}} Normalised answer.
 */
function normaliseNumber(question, raw) {
  const value = typeof raw === 'object' && raw !== null ? raw.number : raw;
  const number = typeof value === 'string' ? Number(value) : value;

  if (typeof number !== 'number' || !Number.isFinite(number) || !Number.isInteger(number)) {
    throw new AnswerError('Expected a whole number.');
  }

  const { min, max, step } = question.config;
  if (min !== undefined && number < Number(min)) {
    throw new AnswerError(`Value must be at least ${min}.`);
  }
  if (max !== undefined && number > Number(max)) {
    throw new AnswerError(`Value must be at most ${max}.`);
  }
  if (step && min !== undefined && (number - Number(min)) % Number(step) !== 0) {
    throw new AnswerError(`Value must be a multiple of ${step} from ${min}.`);
  }
  return { number };
}

/**
 * Validates the optional free-text companion on a choice question.
 *
 * @param {object} question Question row, including `config`.
 * @param {*} raw Submitted "other" text.
 * @returns {string|null} Trimmed text, or null when none was supplied.
 */
function normaliseOther(question, raw) {
  if (isBlank(raw)) return null;
  if (!question.config.allowOther) {
    throw new AnswerError('This question does not accept a custom answer.');
  }
  if (typeof raw !== 'string') throw new AnswerError('Custom answer must be text.');

  const trimmed = raw.trim();
  const max = Number(question.config.otherMaxLength ?? LIMITS.other_text.maxLength);
  if (trimmed.length > max) {
    throw new AnswerError(`Custom answer must be at most ${max} characters.`);
  }
  return trimmed;
}

/**
 * Validates a single-choice answer.
 *
 * @param {object} question Question row, including `config`.
 * @param {Set<string>} optionIds Valid option ids for the question.
 * @param {*} raw Submitted value.
 * @returns {{optionId: string|null, other: string|null}} Normalised answer.
 */
function normaliseSingleChoice(question, optionIds, raw) {
  const optionId = typeof raw === 'string' ? raw : raw?.optionId ?? null;
  const other = normaliseOther(question, raw?.other);

  if (optionId === null) {
    if (other === null) throw new AnswerError('Select an option.');
    return { optionId: null, other };
  }
  if (!optionIds.has(optionId)) throw new AnswerError('Unknown option selected.');

  // A chosen preset option and a custom answer are mutually exclusive.
  return { optionId, other: null };
}

/**
 * Validates a multi-choice answer.
 *
 * @param {object} question Question row, including `config`.
 * @param {Set<string>} optionIds Valid option ids for the question.
 * @param {*} raw Submitted value.
 * @returns {{optionIds: string[], other: string|null}} Normalised answer.
 */
function normaliseMultiChoice(question, optionIds, raw) {
  const selected = Array.isArray(raw) ? raw : raw?.optionIds;
  if (!Array.isArray(selected)) throw new AnswerError('Expected a list of options.');

  const unique = [...new Set(selected)];
  if (unique.length !== selected.length) throw new AnswerError('Duplicate option selected.');
  for (const id of unique) {
    if (!optionIds.has(id)) throw new AnswerError('Unknown option selected.');
  }

  const other = normaliseOther(question, raw?.other);
  const total = unique.length + (other === null ? 0 : 1);

  // A bound of 0 is meaningful (and falsy), so presence is tested rather than
  // truthiness.
  const { minSelections, maxSelections } = question.config;
  if (minSelections !== undefined && minSelections !== null && total < Number(minSelections)) {
    throw new AnswerError(
      Number(minSelections) === 1
        ? 'Select at least one option.'
        : `Select at least ${minSelections} options.`,
    );
  }
  if (maxSelections !== undefined && maxSelections !== null && total > Number(maxSelections)) {
    throw new AnswerError(
      Number(maxSelections) === 0
        ? 'This question does not accept any selections.'
        : `Select at most ${maxSelections} option${Number(maxSelections) === 1 ? '' : 's'}.`,
    );
  }
  return { optionIds: unique, other };
}

/**
 * Validates a priority ranking, which must order every option exactly once.
 *
 * @param {Set<string>} optionIds Valid option ids for the question.
 * @param {*} raw Submitted value.
 * @returns {{order: string[]}} Normalised answer.
 */
function normaliseRanking(optionIds, raw) {
  const order = Array.isArray(raw) ? raw : raw?.order;
  if (!Array.isArray(order)) throw new AnswerError('Expected a ranked list.');

  const unique = new Set(order);
  if (unique.size !== order.length) throw new AnswerError('Each option may appear once.');
  if (unique.size !== optionIds.size) throw new AnswerError('Rank every option.');
  for (const id of order) {
    if (!optionIds.has(id)) throw new AnswerError('Unknown option in ranking.');
  }
  return { order };
}

/**
 * Validates a true/false answer.
 *
 * @param {*} raw Submitted value.
 * @returns {{bool: boolean}} Normalised answer.
 */
function normaliseBoolean(raw) {
  const value = typeof raw === 'object' && raw !== null ? raw.bool : raw;
  if (typeof value === 'boolean') return { bool: value };
  if (value === 'true') return { bool: true };
  if (value === 'false') return { bool: false };
  throw new AnswerError('Expected true or false.');
}

/**
 * Validates a file-upload answer.
 *
 * The bytes are stored by a dedicated upload route; the answer only carries a
 * reference to what was already stored, so validation here just confirms the
 * reference is well formed.
 *
 * @param {*} raw Submitted value.
 * @returns {{fileId: string, filename: string, size: number}} Normalised answer.
 */
function normaliseFile(raw) {
  const fileId = raw?.fileId;
  if (typeof fileId !== 'string' || fileId.length === 0) {
    throw new AnswerError('Upload a file to answer this question.');
  }
  return {
    fileId,
    filename: typeof raw.filename === 'string' ? raw.filename : 'file',
    size: Number.isFinite(raw.size) ? raw.size : 0,
  };
}

/**
 * Validates and normalises one answer against its question.
 *
 * @param {object} question Question row with `type`, `required`, `config`.
 * @param {Array<{id: string}>} options The question's options, empty for
 *   non-choice types.
 * @param {*} raw Submitted value in any of the shapes the client may send.
 * @returns {object} Canonical value for `answers.value`.
 * @throws {AnswerError} When the answer is missing or fails the type's rules.
 */
export function normaliseAnswer(question, options, raw) {
  if (isBlank(raw)) {
    if (question.required) throw new AnswerError('This question is required.');
    return { skipped: true };
  }

  const optionIds = new Set(options.map((option) => option.id));

  switch (question.type) {
    case 'short_text':
    case 'long_text':
      return normaliseText(question, raw);
    case 'integer':
    case 'scale':
      return normaliseNumber(question, raw);
    case 'single_choice':
      return normaliseSingleChoice(question, optionIds, raw);
    case 'multi_choice':
      return normaliseMultiChoice(question, optionIds, raw);
    case 'ranking':
      return normaliseRanking(optionIds, raw);
    case 'boolean':
      return normaliseBoolean(raw);
    case 'file_upload':
      return normaliseFile(raw);
    default:
      throw new AnswerError(`Unsupported question type: ${question.type}`);
  }
}
