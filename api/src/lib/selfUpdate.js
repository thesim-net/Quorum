import { query } from '../db/pool.js';
import { loadSettings } from './settings.js';
import { updateStatus, parseSemver } from './update.js';
import { dockerAvailable, imagePresent, pullImage, runDetached } from './docker.js';

/**
 * Fetching a new version, and restarting into it.
 *
 * Both need the Docker socket, which is not mounted by default: granting it to
 * a public-facing container is granting root on the host.
 */

const IMAGES = ['ghcr.io/thesim-net/quorum-api', 'ghcr.io/thesim-net/quorum-web'];

/** Where the compose project is mounted inside this container, if it is. */
const composeDir = () => process.env.QUORUM_COMPOSE_DIR ?? null;

/** Runs `docker compose up -d` for us; a container cannot recreate itself. */
const updaterImage = () => process.env.QUORUM_UPDATER_IMAGE ?? 'docker:27-cli';

/**
 * Reads the schedule from the row rather than the settings cache, which is
 * only refreshed in whichever process handled the save.
 *
 * @returns {Promise<object>} The schedule and its recorded state.
 */
export async function autoUpdateState() {
  const { rows } = await query(
    `SELECT auto_update_enabled, auto_update_interval_seconds, auto_update_restart,
            auto_update_last_run_at, auto_update_staged_version, auto_update_last_error
       FROM app_settings WHERE id = true`,
  );
  const row = rows[0] ?? {};

  return {
    enabled: Boolean(row.auto_update_enabled),
    intervalSeconds: row.auto_update_interval_seconds ?? null,
    restart: Boolean(row.auto_update_restart),
    lastRunAt: row.auto_update_last_run_at ?? null,
    stagedVersion: row.auto_update_staged_version ?? null,
    lastError: row.auto_update_last_error ?? null,
  };
}

/**
 * Records the outcome. The error is stored, not just logged, so the settings
 * page can show why nothing is happening.
 *
 * @param {{stagedVersion?: string|null, error?: string|null, ran?: boolean}} outcome
 * @returns {Promise<void>}
 */
async function record({ stagedVersion, error = null, ran = true }) {
  await query(
    `UPDATE app_settings
        SET auto_update_last_run_at = CASE WHEN $3 THEN now() ELSE auto_update_last_run_at END,
            auto_update_staged_version =
              COALESCE($1, auto_update_staged_version),
            auto_update_last_error = $2,
            updated_at = now()
      WHERE id = true`,
    [stagedVersion ?? null, error, ran],
  );
  await loadSettings();
}

/**
 * Downloads the newest release without restarting. Ordinary outcomes come back
 * as a status rather than an exception; they are answers, not failures.
 *
 * @returns {Promise<{status: string, version?: string, message?: string}>}
 */
export async function pullUpdate() {
  if (!(await dockerAvailable())) {
    const message =
      'The Docker socket is not available to this container, so Quorum cannot download updates.';
    await record({ error: message, ran: false });
    return { status: 'unavailable', message };
  }

  const status = await updateStatus(true);
  if (!status.updateAvailable || !status.latest) {
    await record({ error: null });
    return { status: 'current', version: status.current };
  }

  // Release tags carry a leading v; image tags do not.
  const version = parseSemver(status.latest) ? status.latest.replace(/^v/, '') : null;
  if (!version) {
    const message = `Could not read a version from release "${status.latest}".`;
    await record({ error: message });
    return { status: 'failed', message };
  }

  try {
    // Both, or neither: a web container newer than its API is a broken stack.
    for (const image of IMAGES) await pullImage(image, version);
  } catch (error) {
    const message = `Downloading ${version} failed: ${error.message}`;
    await record({ error: message });
    return { status: 'failed', message };
  }

  await record({ stagedVersion: version, error: null });
  return { status: 'downloaded', version };
}

/**
 * Restarts into a downloaded version, via a detached container that outlives
 * this one. Success means the updater started, not that the upgrade finished -
 * the new API clears the staged marker on boot, which is the real confirmation.
 *
 * @param {string|null} requested Version to apply; defaults to the staged one.
 * @returns {Promise<{status: string, version?: string, message?: string}>}
 */
export async function applyUpdate(requested = null) {
  const state = await autoUpdateState();
  const version = requested ?? state.stagedVersion;

  if (!version) return { status: 'nothing-staged' };
  if (!(await dockerAvailable())) {
    return {
      status: 'unavailable',
      message: 'The Docker socket is not available to this container, so it cannot restart itself.',
    };
  }
  if (!composeDir()) {
    return {
      status: 'unavailable',
      message: 'QUORUM_COMPOSE_DIR is not set, so Quorum does not know which project to restart.',
    };
  }

  // Refuse to restart into something not on disk: compose would try to pull it
  // itself, after stopping the thing serving the admin panel.
  for (const image of IMAGES) {
    if (!(await imagePresent(image, version))) {
      return {
        status: 'not-downloaded',
        message: `${image}:${version} is not on this host yet. Download the update first.`,
      };
    }
  }

  try {
    await runDetached({
      image: updaterImage(),
      // The version is pinned by the updater rather than here: a compose
      // project's .env is typically 0600 root, and this container is not root.
      // It also goes in the environment, which compose prefers over .env, so
      // the right version starts even if the file cannot be written at all.
      cmd: [
        'sh',
        '-c',
        `if grep -q '^QUORUM_VERSION=' .env 2>/dev/null; then ` +
          `sed -i 's/^QUORUM_VERSION=.*/QUORUM_VERSION=${version}/' .env; ` +
          `else echo 'QUORUM_VERSION=${version}' >> .env; fi; ` +
          `docker compose up -d`,
      ],
      env: [`QUORUM_VERSION=${version}`],
      binds: [
        `${process.env.DOCKER_SOCKET ?? '/var/run/docker.sock'}:/var/run/docker.sock`,
        `${process.env.QUORUM_COMPOSE_HOST_DIR ?? composeDir()}:/project`,
      ],
      workingDir: '/project',
    });
  } catch (error) {
    const message = `Restarting into ${version} failed: ${error.message}`;
    await record({ error: message, ran: false });
    return { status: 'failed', message };
  }

  return { status: 'restarting', version };
}

/**
 * Clears the staged marker at boot, once this process IS that version. The
 * updater cannot report success: its last act is to stop the listener.
 *
 * @param {string} runningVersion The version this process is.
 * @returns {Promise<void>}
 */
export async function clearStagedIfRunning(runningVersion) {
  await query(
    `UPDATE app_settings
        SET auto_update_staged_version = NULL, auto_update_last_error = NULL, updated_at = now()
      WHERE id = true AND auto_update_staged_version = $1`,
    [runningVersion],
  );
}
