/**
 * Pure policy for how many times someone may answer a survey, and which of
 * their responses a request is about.
 *
 * Three settings meet here, and each is the survey author's own decision:
 * whether one person gets one response, whether answers may be changed after
 * submitting, and (elsewhere) whether the guild gate applies. Nothing here
 * couples them - it only says what each combination means, so the routes never
 * have to guess.
 */

/** What `POST /:slug/start` should do with whatever it found. */
export const START = {
  RESUME: 'resume',
  CREATE: 'create',
  REFUSE: 'refuse',
};

/**
 * Whether a survey holds each person to a single response.
 *
 * Absent means on: that was the only behaviour before the column existed, and
 * it is the default a new survey is created with.
 *
 * @param {{one_response_per_person?: boolean}} survey Survey row.
 * @returns {boolean} True when one person gets one response.
 */
export const oneResponsePerPerson = (survey) => survey?.one_response_per_person !== false;

/**
 * Whether the same person may answer a survey more than once.
 *
 * @param {object} survey Survey row.
 * @returns {boolean} True when repeats are allowed.
 */
export const allowsRepeat = (survey) => !oneResponsePerPerson(survey);

/**
 * When a response was put in front of the survey owner.
 *
 * @param {{completed_at?: string|Date|null, started_at: string|Date}} response
 * @returns {number} Milliseconds since the epoch.
 */
const submittedAt = (response) =>
  new Date(response.completed_at ?? response.started_at).getTime();

/**
 * Which of a respondent's responses this request is about.
 *
 * A one-per-person survey has at most one, so this is a formality for it. Where
 * repeats are allowed there may be several, and the choice has to be defined
 * rather than left to whichever row the database happened to return first: an
 * attempt still in progress is always the one being worked on, and otherwise it
 * is the most recently submitted, which is the only thing "change my answers"
 * can mean once there is more than one.
 *
 * @param {object[]} responses Every response held under one respondent hash.
 * @returns {object|null} The response in play, or null when there is none.
 */
export function currentAttempt(responses = []) {
  if (responses.length <= 1) return responses[0] ?? null;

  const inProgress = responses.filter((response) => response.status === 'in_progress');
  const pool = inProgress.length > 0 ? inProgress : responses;

  return [...pool].sort((a, b) => submittedAt(b) - submittedAt(a))[0];
}

/**
 * Decides what starting a survey means for this respondent.
 *
 * Editing, where the survey allows it, always wins over starting again: someone
 * who comes back to a survey that lets them change their answers is far more
 * likely to mean the response they already gave than a second one. Where
 * editing is off, a survey that allows repeats hands them a fresh response and
 * one that does not turns them away.
 *
 * @param {object} survey Survey row.
 * @param {object|null} existing The respondent's current response, if any.
 * @returns {string} A START value.
 */
export function startAction(survey, existing) {
  if (!existing) return START.CREATE;
  if (existing.status !== 'completed') return START.RESUME;

  if (survey.allow_response_edits) return START.RESUME;
  if (allowsRepeat(survey)) return START.CREATE;
  return START.REFUSE;
}
