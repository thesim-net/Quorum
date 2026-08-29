/**
 * Shared display formatting.
 */

/**
 * Renders a duration in the largest sensible unit.
 *
 * @param {number|null} ms Milliseconds.
 * @returns {string} Formatted duration, or a dash when there is nothing to show.
 */
export function duration(ms) {
  if (!ms && ms !== 0) return '-';

  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;

  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/**
 * Renders a timestamp in the reader's own locale.
 *
 * @param {string|null} iso ISO timestamp.
 * @returns {string} Formatted date and time, or a dash.
 */
export function when(iso) {
  if (!iso) return '-';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '-' : date.toLocaleString();
}

/**
 * Shortens text to fit a control, with an ellipsis when it is cut.
 *
 * @param {string} text
 * @param {number} max Longest result, ellipsis included.
 * @returns {string} The text, or its first characters plus a marker.
 */
export function truncate(text, max) {
  const value = String(text ?? '');
  // The ellipsis is part of the budget, so the result never exceeds `max` -
  // otherwise a cap meant to fit a control would overshoot it by three.
  return value.length > max ? `${value.slice(0, max - 3).trimEnd()}...` : value;
}
