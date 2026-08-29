import { request as httpRequest } from 'node:http';
import { access } from 'node:fs/promises';

/**
 * A very small Docker Engine client, over the unix socket.
 *
 * Spoken directly because the image has no docker binary, and no library
 * because `http.request` takes a socket path natively. The socket is not
 * mounted by default; nothing here works until it is.
 */

const SOCKET = process.env.DOCKER_SOCKET ?? '/var/run/docker.sock';

/** How long any one Engine call may take. A pull is given its own, longer. */
const TIMEOUT_MS = 30_000;
const PULL_TIMEOUT_MS = 15 * 60 * 1000;

export class DockerError extends Error {
  constructor(message, status = null) {
    super(message);
    this.name = 'DockerError';
    this.status = status;
  }
}

/**
 * Whether this container can reach the Engine, so the settings page can say
 * so up front rather than accepting a schedule that could never run.
 *
 * @returns {Promise<boolean>} True when the socket is present and readable.
 */
export async function dockerAvailable() {
  try {
    await access(SOCKET);
    await engine('GET', '/_ping', { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Issues one Engine API call over the socket.
 *
 * @param {string} method HTTP method.
 * @param {string} path Path below the Engine root, e.g. `/containers/json`.
 * @param {{timeout?: number, raw?: boolean, body?: object}} options
 * @returns {Promise<*>} Parsed JSON, or raw text when `raw` is set.
 * @throws {DockerError} On a non-2xx status, a timeout, or an unreachable socket.
 */
function engine(method, path, { timeout = TIMEOUT_MS, raw = false, body: payload } = {}) {
  return new Promise((resolve, reject) => {
    const encoded = payload === undefined ? null : JSON.stringify(payload);

    const req = httpRequest(
      {
        socketPath: SOCKET,
        path,
        method,
        headers: {
          Host: 'docker',
          ...(encoded
            ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(encoded) }
            : {}),
        },
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('end', () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            return reject(new DockerError(`Docker ${method} ${path} failed: ${body}`, res.statusCode));
          }
          if (raw) return resolve(body);
          try {
            return resolve(body ? JSON.parse(body) : null);
          } catch {
            // A streaming endpoint returns newline-delimited JSON rather than
            // one document. The caller that wants the stream asks for raw.
            return resolve(body);
          }
        });
      },
    );

    req.setTimeout(timeout, () => {
      req.destroy(new DockerError(`Docker ${method} ${path} timed out`));
    });
    req.on('error', (error) =>
      reject(error instanceof DockerError ? error : new DockerError(error.message)),
    );
    if (encoded) req.write(encoded);
    req.end();
  });
}

/**
 * Pulls one image tag.
 *
 * The Engine reports pull failures inside a streamed body, not in the status
 * code, so returning on the 200 alone would stage a version that never landed.
 *
 * @param {string} image Repository, e.g. `ghcr.io/thesim-net/quorum-api`.
 * @param {string} tag Tag to pull.
 * @returns {Promise<void>}
 * @throws {DockerError} When the pull fails.
 */
export async function pullImage(image, tag) {
  const path = `/images/create?fromImage=${encodeURIComponent(image)}&tag=${encodeURIComponent(tag)}`;
  const body = await engine('POST', path, { timeout: PULL_TIMEOUT_MS, raw: true });

  for (const line of String(body).split('\n')) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      if (event.error) throw new DockerError(`Pull of ${image}:${tag} failed: ${event.error}`);
    } catch (error) {
      // A partial trailing line is not an error; a reported one is.
      if (error instanceof DockerError) throw error;
    }
  }
}

/**
 * Whether an image tag is present on this host.
 *
 * @param {string} image Repository.
 * @param {string} tag Tag.
 * @returns {Promise<boolean>} True when the image is already local.
 */
export async function imagePresent(image, tag) {
  try {
    await engine('GET', `/images/${encodeURIComponent(`${image}:${tag}`)}/json`);
    return true;
  } catch (error) {
    if (error instanceof DockerError && error.status === 404) return false;
    throw error;
  }
}

/**
 * Runs one detached, self-removing container. A container cannot recreate
 * itself, so the restart is handed to one that outlives it.
 *
 * @param {{image: string, cmd: string[], binds: string[], workingDir?: string,
 *   env?: string[]}} spec What to run.
 * @returns {Promise<string>} The new container's id.
 */
export async function runDetached({ image, cmd, binds, workingDir, env = [] }) {
  const created = await engine('POST', `/containers/create?name=quorum-updater-${Date.now()}`, {
    timeout: TIMEOUT_MS,
    body: {
      Image: image,
      Cmd: cmd,
      Env: env,
      WorkingDir: workingDir,
      HostConfig: { Binds: binds, AutoRemove: true, NetworkMode: 'host' },
    },
  });

  await engine('POST', `/containers/${created.Id}/start`);
  return created.Id;
}
