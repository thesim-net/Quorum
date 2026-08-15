import { VERSION } from './version.js';

/**
 * Update availability checking.
 *
 * The API asks GitHub for the repo's latest release and compares it to the
 * running version. The app never touches Docker itself; it only tells an admin
 * that a newer version exists and how to apply it. The result is cached so the
 * outbound request happens at most a few times a day.
 *
 * The two settings are read from the environment here rather than through the
 * config module, so the pure comparison helpers can be unit-tested without a
 * full runtime configuration.
 */

const TTL_MS = 6 * 60 * 60 * 1000;
let cache = null;

/** Whether update checking is enabled. */
const checkEnabled = () => process.env.UPDATE_CHECK !== 'off';

/** The repo whose latest release is polled. */
const checkRepo = () => process.env.UPDATE_CHECK_REPO ?? 'TheSim-net/Quorum';

/**
 * Parses a semantic version, tolerating a leading "v".
 *
 * @param {string} value e.g. "v1.2.3" or "1.2.3".
 * @returns {[number, number, number]|null} Parsed parts, or null.
 */
export function parseSemver(value) {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(String(value ?? ''));
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

/**
 * Whether `latest` is a strictly newer version than `current`.
 *
 * @param {string} latest Candidate version.
 * @param {string} current Running version.
 * @returns {boolean} True when an update is available.
 */
export function isNewer(latest, current) {
  const a = parseSemver(latest);
  const b = parseSemver(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i += 1) {
    if (a[i] > b[i]) return true;
    if (a[i] < b[i]) return false;
  }
  return false;
}

/**
 * Resolves whether an update is available, using the cached result when fresh.
 *
 * Any failure (checks disabled, network error, no releases yet) resolves to
 * "no update" rather than surfacing an error, so a GitHub outage never breaks
 * the admin panel.
 *
 * @param {boolean} force Bypass the cache and re-check now.
 * @returns {Promise<{current: string, latest: string|null, updateAvailable: boolean, url: string|null}>}
 */
export async function updateStatus(force = false) {
  const base = { current: VERSION, latest: null, updateAvailable: false, url: null };

  if (!checkEnabled()) return base;
  if (!force && cache && Date.now() - cache.at < TTL_MS) return { ...base, ...cache.value };

  let value = { latest: null, updateAvailable: false, url: null };
  try {
    const res = await fetch(
      `https://api.github.com/repos/${checkRepo()}/releases/latest`,
      { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Quorum' } },
    );
    if (res.ok) {
      const data = await res.json();
      const latest = data.tag_name ?? null;
      value = {
        latest,
        updateAvailable: latest ? isNewer(latest, VERSION) : false,
        url: data.html_url ?? null,
      };
    }
  } catch {
    // Leave value as "no update"; a failed check must never block the panel.
  }

  cache = { at: Date.now(), value };
  return { ...base, ...value };
}
