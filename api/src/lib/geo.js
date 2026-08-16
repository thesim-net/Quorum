import { config } from '../config.js';
import { countryOfIp, loadTable } from './rir.js';

/**
 * Country lookup for the optional location metric.
 *
 * Resolution happens entirely in-process against a table compiled from the
 * RIRs' own delegation statistics - no request carrying a visitor's address
 * ever leaves the host - and only the two-letter country code is returned. The
 * caller never persists the address it passed in.
 */

let table = null;
let loading = null;

/**
 * Loads the range table once, in the background.
 *
 * Building it means fetching several megabytes from five registries, so the
 * first requests after a cold start must not sit and wait for it. They resolve
 * to null (recorded as unknown) and later requests get real answers. That is a
 * better trade than making a respondent watch a survey page hang.
 *
 * @returns {Promise<object|null>}
 */
function ensureTable() {
  if (table) return Promise.resolve(table);
  if (loading) return loading;

  loading = loadTable(config.geoDataDir, config.geoRefreshDays)
    .then((loaded) => {
      table = loaded;
      if (loaded) {
        console.log(
          `Country ranges ready: ${loaded.v4.start.length} IPv4 and ` +
            `${loaded.v6.start.length} IPv6 allocations.`,
        );
      }
      return loaded;
    })
    .catch((error) => {
      console.warn(`Country ranges unavailable (${error.message}); location metrics disabled.`);
      return null;
    });

  return loading;
}

/** Kicks off the load without blocking anything. Called once at startup. */
export function warmGeo() {
  if (config.geoDataDir) void ensureTable();
}

/**
 * Extracts the originating client address from a proxied request.
 *
 * Reads X-Forwarded-For right-to-left and skips `trustProxyHops` entries, so a
 * client that forges the header cannot push a chosen value into the trusted
 * position.
 *
 * @param {import('express').Request} req
 * @returns {string|null} Client IP, or null when it cannot be determined.
 */
export function clientIp(req) {
  const header = req.headers['x-forwarded-for'];
  if (!header) return req.socket.remoteAddress ?? null;

  const chain = String(header)
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);

  const index = chain.length - config.trustProxyHops;
  return chain[index] ?? chain[0] ?? req.socket.remoteAddress ?? null;
}

/**
 * Resolves a request's country of origin.
 *
 * @param {import('express').Request} req
 * @returns {Promise<string|null>} ISO 3166-1 alpha-2 code, or null when the
 *   address is private, unresolvable, or the table is not loaded yet.
 */
export async function countryOf(req) {
  if (!config.geoDataDir) return null;

  // Never wait on the table. If it is still compiling, this response is simply
  // recorded without a country.
  const ranges = table ?? (loading ? null : await ensureTable());
  if (!ranges) return null;

  return countryOfIp(ranges, clientIp(req));
}
