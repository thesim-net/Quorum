import { readFileSync } from 'node:fs';

/**
 * The running version, read once from package.json.
 *
 * A single source of truth shared by the health/version endpoints and the
 * update checker, so they can never disagree about what is running.
 */
export const VERSION = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
).version;
