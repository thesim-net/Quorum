/**
 * The automatic update schedule.
 *
 * Downloading and restarting are separate switches: a pull is invisible, a
 * restart drops in-flight responses and runs migrations.
 */

/** The shortest interval a deployment may check on: twice a day. */
export const MIN_INTERVAL_SECONDS = 12 * 60 * 60;

const DAY_SECONDS = 24 * 60 * 60;
const HOUR_SECONDS = 60 * 60;

/**
 * Reads one field of the interval. Blank means zero; junk is refused rather
 * than coerced, since Number('abc') would otherwise join the total as NaN.
 *
 * @param {*} value
 * @returns {number|null} The count, or null when the value is not one.
 */
const asCount = (value) => {
  if (value === '' || value === null || value === undefined) return 0;

  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : null;
};

/**
 * Collapses days, hours and seconds into one interval.
 *
 * @param {{days: *, hours: *, seconds: *}} parts
 * @returns {number} Total seconds.
 */
export const toSeconds = ({ days = 0, hours = 0, seconds = 0 }) =>
  Number(days) * DAY_SECONDS + Number(hours) * HOUR_SECONDS + Number(seconds);

/**
 * Splits an interval back into the parts the form shows.
 *
 * @param {number|null} total Interval in seconds.
 * @returns {{days: number, hours: number, seconds: number}} The parts.
 */
export function toParts(total) {
  const value = Number(total);
  if (!Number.isFinite(value) || value <= 0) return { days: 0, hours: 0, seconds: 0 };

  return {
    days: Math.floor(value / DAY_SECONDS),
    hours: Math.floor((value % DAY_SECONDS) / HOUR_SECONDS),
    seconds: value % HOUR_SECONDS,
  };
}

/**
 * Validates a submitted schedule.
 *
 * Returns the interval to store rather than a boolean, so the caller cannot
 * recompute it into something other than what was checked.
 *
 * @param {{enabled: boolean, days: *, hours: *, seconds: *}} input
 * @returns {{ok: true, seconds: number|null}|{ok: false, error: string}}
 */
export function validateSchedule({ enabled, days = 0, hours = 0, seconds = 0 }) {
  // Disabled keeps no interval, so re-enabling cannot resume an old cadence.
  if (!enabled) return { ok: true, seconds: null };

  const counts = [days, hours, seconds].map(asCount);
  if (counts.some((count) => count === null)) {
    return { ok: false, error: 'Days, hours and seconds must be whole numbers, and not negative.' };
  }

  const [d, h, s] = counts;
  const total = toSeconds({ days: d, hours: h, seconds: s });

  if (total === 0) {
    return { ok: false, error: 'Choose how often Quorum should check for a new version.' };
  }
  if (total < MIN_INTERVAL_SECONDS) {
    return { ok: false, error: 'Quorum cannot check for updates more than twice a day.' };
  }

  return { ok: true, seconds: total };
}

/**
 * Whether the schedule is due. Never having run counts as due, so enabling it
 * takes effect now rather than after a first full interval.
 *
 * @param {{enabled: boolean, intervalSeconds: number|null,
 *   lastRunAt: string|Date|null}} schedule
 * @param {number} now Milliseconds since the epoch.
 * @returns {boolean} True when a check should happen now.
 */
export function isDue(schedule, now) {
  if (!schedule?.enabled || !schedule.intervalSeconds) return false;
  if (!schedule.lastRunAt) return true;

  const last = new Date(schedule.lastRunAt).getTime();
  if (Number.isNaN(last)) return true;

  return now - last >= schedule.intervalSeconds * 1000;
}

/**
 * Describes an interval in the words the settings page uses.
 *
 * @param {number|null} total Interval in seconds.
 * @returns {string} Human-readable cadence.
 */
export function describeInterval(total) {
  if (!total) return 'never';

  const { days, hours, seconds } = toParts(total);
  const parts = [];
  if (days) parts.push(`${days} day${days === 1 ? '' : 's'}`);
  if (hours) parts.push(`${hours} hour${hours === 1 ? '' : 's'}`);
  if (seconds) parts.push(`${seconds} second${seconds === 1 ? '' : 's'}`);

  return `every ${parts.join(', ')}`;
}

/**
 * The compose project name a host directory implies.
 *
 * Pure, and tested, because getting it wrong does not fail loudly: compose
 * simply builds a SECOND stack under the wrong name, with its own empty
 * database, beside the one it was asked to upgrade.
 *
 * Mirrors what compose itself does to a directory name - lowercase, and drop
 * what it will not accept - so the name passed back is the one already in use.
 *
 * @param {string|null} hostPath The project directory, as the host knows it.
 * @returns {string|null} The project name, or null when none can be read.
 */
export function projectNameFrom(hostPath) {
  if (!hostPath) return null;

  // Read as text rather than resolved: this process may never have seen the
  // path, and it can carry either separator or a trailing one.
  const parts = String(hostPath).split(/[\\/]+/).filter(Boolean);
  const name = parts[parts.length - 1];
  if (!name) return null;

  return name.toLowerCase().replace(/[^a-z0-9_-]/g, '') || null;
}
