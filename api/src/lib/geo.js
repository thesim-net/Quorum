import { open } from 'maxmind';
import { config } from '../config.js';

/**
 * Country lookup for the optional location metric.
 *
 * Resolution happens entirely in-process against a local MaxMind database - no
 * request ever leaves the host - and only the two-letter country code is
 * returned. The caller never persists the address it passed in.
 */

let reader = null;
let loadAttempted = false;

/**
 * Opens the GeoIP database, once, on first use.
 *
 * A missing or unreadable database is not fatal: location collection simply
 * yields null, so a deployment that has not downloaded GeoLite2 still runs.
 *
 * @returns {Promise<object|null>} maxmind reader, or null when unavailable.
 */
async function getReader() {
  if (loadAttempted) return reader;
  loadAttempted = true;

  if (!config.geoipDbPath) return null;
  try {
    reader = await open(config.geoipDbPath);
  } catch (error) {
    console.warn(`GeoIP database unavailable (${error.message}); location metrics disabled.`);
    reader = null;
  }
  return reader;
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
 *   address is private, unresolvable, or no database is installed.
 */
export async function countryOf(req) {
  const db = await getReader();
  if (!db) return null;

  const ip = clientIp(req);
  if (!ip) return null;

  try {
    const result = db.get(ip);
    return result?.country?.iso_code ?? result?.registered_country?.iso_code ?? null;
  } catch {
    return null;
  }
}
