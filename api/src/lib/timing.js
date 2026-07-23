/**
 * Server-authoritative response timing.
 *
 * The client only ever reports which question it moved to. Every timestamp is
 * taken from the database clock, so reported durations cannot be forged.
 */

/**
 * Longest interval credited to a single stretch on one question.
 *
 * A participant who wanders off mid-survey would otherwise contribute hours to
 * the average. Anything longer is treated as idle and capped.
 */
export const MAX_INTERVAL_MS = 10 * 60 * 1000;

/**
 * Collapses a response's event stream into per-question durations.
 *
 * Each event marks the moment the participant arrived somewhere; the time
 * attributed to that question is the gap until the next event. Revisiting a
 * question accumulates, so back-navigation is counted rather than discarded.
 *
 * @param {Array<{question_id: string|null, at: Date}>} events Events for one
 *   response, ordered by `at` ascending.
 * @returns {Map<string, number>} Question id -> milliseconds spent.
 */
export function collapseEvents(events) {
  const totals = new Map();

  for (let i = 0; i < events.length - 1; i += 1) {
    const { question_id: questionId, at } = events[i];
    if (!questionId) continue;

    const elapsed = new Date(events[i + 1].at) - new Date(at);
    if (elapsed <= 0) continue;

    const credited = Math.min(elapsed, MAX_INTERVAL_MS);
    totals.set(questionId, (totals.get(questionId) ?? 0) + credited);
  }

  return totals;
}

/**
 * Total time credited across a response, after per-interval capping.
 *
 * Derived from the same capped intervals rather than completed_at - started_at,
 * so a response left open overnight does not report a twelve hour duration.
 *
 * @param {Map<string, number>} perQuestion Output of collapseEvents.
 * @returns {number} Milliseconds spent on the survey.
 */
export function totalDuration(perQuestion) {
  let total = 0;
  for (const ms of perQuestion.values()) total += ms;
  return total;
}
