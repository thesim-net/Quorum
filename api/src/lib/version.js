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

/**
 * Git commit the running image was built from, stamped in at build time by CI
 * (see .github/workflows/release.yml). It is surfaced in the footer so the
 * running build can be traced back to its exact source on GitHub. A local build
 * that was not stamped reports "unknown".
 */
export const GIT_SHA = process.env.QUORUM_GIT_SHA || 'unknown';

/** ISO 8601 time the image was built, stamped by CI, or "unknown" locally. */
export const BUILD_TIME = process.env.QUORUM_BUILD_TIME || 'unknown';

/**
 * The source repository the footer links its commit to. Reuses the update
 * check's repo so the two never point at different places.
 */
export const REPO = process.env.UPDATE_CHECK_REPO || 'thomasloupe/Quorum';
