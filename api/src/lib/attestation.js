import { VERSION, GIT_SHA, REPO } from './version.js';

/**
 * Build-provenance self-check.
 *
 * The API verifies its OWN published image and reports whether an official,
 * signed build is running. It resolves the digest that
 * `ghcr.io/<owner>/quorum-api:<version>` currently points at, then asks GitHub
 * whether that digest carries a build-provenance attestation from this repo.
 * Both requests work unauthenticated, so a self-hoster needs no token.
 *
 * What this proves and what it does not:
 * - It is an honest-operator signal. It confirms a deployment is running an
 *   official published image and catches an unofficial or drifted one.
 * - It is NOT proof against an operator who has modified their own server: the
 *   same server renders this result, so a tampered one can lie. The definitive
 *   check runs `gh attestation verify` against the pulled image from outside
 *   that server. The /verify page hands out exactly that command.
 *
 * A local build carries no CI commit stamp, so it reports "local" without any
 * network call: an unpublished build has nothing to verify against.
 *
 * The two repository settings are read from ./version.js (which reads the
 * environment) so the pure formatting helper can be unit-tested without a
 * runtime configuration.
 */

const TTL_MS = 6 * 60 * 60 * 1000;
let cache = null;

/** GHCR namespace owner, lowercased as the registry requires. */
const owner = () => (REPO.split('/')[0] || 'thomasloupe').toLowerCase();

/**
 * Resolves the digest a GHCR tag currently points at.
 *
 * @param {string} repo e.g. "thomasloupe/quorum-api".
 * @param {string} ref A tag or digest.
 * @returns {Promise<string|null>} The `sha256:...` digest, or null on failure.
 */
async function resolveDigest(repo, ref) {
  const tokenRes = await fetch(
    `https://ghcr.io/token?scope=repository:${repo}:pull&service=ghcr.io`,
  );
  if (!tokenRes.ok) return null;
  const { token } = await tokenRes.json();

  const res = await fetch(`https://ghcr.io/v2/${repo}/manifests/${ref}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: [
        'application/vnd.oci.image.manifest.v1+json',
        'application/vnd.oci.image.index.v1+json',
        'application/vnd.docker.distribution.manifest.v2+json',
        'application/vnd.docker.distribution.manifest.list.v2+json',
      ].join(','),
    },
  });
  if (!res.ok) return null;
  return res.headers.get('docker-content-digest');
}

/**
 * Determines the attestation state by talking to GHCR and GitHub.
 *
 * @returns {Promise<{state: string, digest: string|null}>}
 */
async function probe() {
  // No CI stamp means this is a local build; there is nothing published to
  // check it against, so say so plainly rather than calling out to the network.
  if (!GIT_SHA || GIT_SHA === 'unknown') return { state: 'local', digest: null };

  let digest = null;
  try {
    digest = await resolveDigest(`${owner()}/quorum-api`, VERSION);
  } catch {
    // fall through to unknown
  }
  if (!digest) return { state: 'unknown', digest: null };

  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/attestations/${digest}`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Quorum' },
    });
    if (res.ok) {
      const data = await res.json();
      const signed = Array.isArray(data.attestations) && data.attestations.length > 0;
      return { state: signed ? 'verified' : 'unverified', digest };
    }
    // A clean 404 means the digest exists but carries no attestation: a genuine
    // "unverified". Anything else is a transient failure, not a verdict.
    if (res.status === 404) return { state: 'unverified', digest };
    return { state: 'unknown', digest };
  } catch {
    return { state: 'unknown', digest };
  }
}

/**
 * Shapes a state and digest into the full status the API returns. Pure, so it
 * can be tested without any network.
 *
 * @param {string} state One of verified | unverified | unknown | local.
 * @param {string|null} digest The resolved image digest, when known.
 * @returns {object} The attestation status payload (without plugins).
 */
export function formatStatus(state, digest) {
  const o = owner();
  return {
    state,
    version: VERSION,
    commit: GIT_SHA,
    repo: REPO,
    digest,
    image: `ghcr.io/${o}/quorum-api`,
    attestationUrl: `https://github.com/${REPO}/attestations`,
    verify: {
      api: `gh attestation verify oci://ghcr.io/${o}/quorum-api:${VERSION} --repo ${REPO}`,
      web: `gh attestation verify oci://ghcr.io/${o}/quorum-web:${VERSION} --repo ${REPO}`,
    },
  };
}

/**
 * Resolves the current attestation status, cached so the outbound requests
 * happen at most a few times a day. A transient failure ("unknown") is not
 * cached, so the next visitor triggers a fresh attempt.
 *
 * @param {boolean} force Bypass the cache and re-check now.
 * @returns {Promise<object>} The attestation status.
 */
export async function attestationStatus(force = false) {
  if (!force && cache && Date.now() - cache.at < TTL_MS) return cache.value;

  const { state, digest } = await probe();
  const value = formatStatus(state, digest);
  if (state !== 'unknown') cache = { at: Date.now(), value };
  return value;
}
