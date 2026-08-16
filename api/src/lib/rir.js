import { mkdir, readFile, writeFile, stat, rename } from 'node:fs/promises';
import net from 'node:net';
import { dirname, join } from 'node:path';

/**
 * Country ranges built from the Regional Internet Registries' own published
 * delegation statistics.
 *
 * The five RIRs are the bodies that actually hand out address space, and each
 * publishes the full list of what it allocated and to which country. That makes
 * them the primary source rather than a redistribution of one, so there is no
 * account to hold, no key to rotate, no licence to attribute, and no third
 * party in the loop.
 *
 * The trade-off is honest: this is the country an allocation was *registered*
 * to, which is the right answer for "roughly where did this response come from"
 * and the wrong tool for anything needing street-level precision. A block
 * registered to one country and used in another will read as the former, and a
 * visitor on a VPN reads as the VPN. For a survey's location breakdown that is
 * fine; do not repurpose it for access control.
 */

const SOURCES = [
  'https://ftp.ripe.net/pub/stats/ripencc/delegated-ripencc-extended-latest',
  'https://ftp.arin.net/pub/stats/arin/delegated-arin-extended-latest',
  'https://ftp.apnic.net/stats/apnic/delegated-apnic-extended-latest',
  'https://ftp.lacnic.net/pub/stats/lacnic/delegated-lacnic-extended-latest',
  'https://ftp.afrinic.net/pub/stats/afrinic/delegated-afrinic-extended-latest',
];

/** Cache format version. Bumping it invalidates every existing cache file. */
const CACHE_VERSION = 1;

/** Per-request ceiling. RIPE's file is the largest, at around 18 MB. */
const REQUEST_TIMEOUT_MS = 60_000;

/** Attempts per registry before giving up on it for this build. */
const FETCH_ATTEMPTS = 3;

/**
 * How long to wait for one address family before trying the next.
 *
 * Node tries IPv6 and IPv4 in parallel and abandons an attempt after 250 ms by
 * default. A container without an IPv6 route - which is the default for Docker -
 * fails IPv6 instantly, so the IPv4 attempt is the only one that can succeed;
 * if the registry is further away than that window, every attempt is abandoned
 * just before it completes and the whole fetch reports ETIMEDOUT in under a
 * third of a second. AFRINIC is roughly 260 ms from Europe, which is exactly
 * far enough to lose a continent's worth of allocations to a default.
 */
const FAMILY_ATTEMPT_TIMEOUT_MS = 3_000;

/**
 * A table built while a registry was unreachable is missing that registry's
 * continent. Rather than serve that gap for a full refresh period, a partial
 * cache is treated as stale after a day so the next start tries again.
 */
const PARTIAL_REFRESH_DAYS = 1;

/** Returned by {@link lookup} when no allocation covers the value. */
const NO_MATCH = -1;

/**
 * Parses dotted-quad IPv4 into a 32-bit integer.
 *
 * @param {string} text
 * @returns {number|null}
 */
export function ipv4ToInt(text) {
  const parts = text.split('.');
  if (parts.length !== 4) return null;

  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = value * 256 + octet;
  }
  return value;
}

/**
 * Parses an IPv6 address into its high 64 bits.
 *
 * Registries allocate IPv6 in blocks of /32 to /48, so the top half of the
 * address is always enough to identify which allocation an address falls in.
 * Carrying the low half would double the table for no extra resolution.
 *
 * @param {string} text
 * @returns {bigint|null}
 */
export function ipv6ToHigh64(text) {
  const address = text.trim().toLowerCase();
  if (!address.includes(':')) return null;

  const [head, tail = ''] = address.split('::');
  const headGroups = head ? head.split(':').filter(Boolean) : [];
  const tailGroups = tail ? tail.split(':').filter(Boolean) : [];

  if (!address.includes('::') && headGroups.length !== 8) return null;
  const missing = 8 - headGroups.length - tailGroups.length;
  if (missing < 0) return null;

  const groups = [...headGroups, ...Array(missing).fill('0'), ...tailGroups];

  let value = 0n;
  for (let i = 0; i < 4; i += 1) {
    const group = groups[i] ?? '0';
    if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
    value = (value << 16n) | BigInt(parseInt(group, 16));
  }
  return value;
}

/**
 * Turns one RIR delegation file into range records.
 *
 * Lines are `registry|cc|type|start|value|date|status|...`. For ipv4 the value
 * is a host count, which is not always a power of two, so the end is derived by
 * addition rather than by treating it as a prefix length. For ipv6 the value is
 * a prefix length.
 *
 * @param {string} text
 * @returns {{v4: Array<[number, number, string]>, v6: Array<[bigint, bigint, string]>}}
 */
export function parseDelegations(text) {
  const v4 = [];
  const v6 = [];

  for (const line of text.split('\n')) {
    if (!line || line.startsWith('#')) continue;

    const parts = line.split('|');
    if (parts.length < 7) continue;

    const [, cc, type, start, value, , status] = parts;

    // "summary" header rows and unallocated space carry no country.
    if (!cc || cc.length !== 2 || cc === 'ZZ') continue;
    if (status !== 'allocated' && status !== 'assigned') continue;

    if (type === 'ipv4') {
      const first = ipv4ToInt(start);
      const count = Number(value);
      if (first === null || !Number.isFinite(count) || count < 1) continue;
      const last = first + count - 1;
      // A count that runs past the end of the address space is corrupt input.
      // Left alone it would wrap when stored, producing a range whose end sits
      // below its start, which breaks the binary search for every allocation
      // after it - so drop the row instead.
      if (last > 4294967295) continue;
      v4.push([first, last, cc]);
    } else if (type === 'ipv6') {
      const first = ipv6ToHigh64(start);
      const prefix = Number(value);
      if (first === null || !Number.isFinite(prefix) || prefix < 1 || prefix > 128) continue;
      // Only the high 64 bits are tracked, so a prefix longer than /64 covers a
      // single value at this resolution.
      const width = prefix >= 64 ? 0n : 64n - BigInt(prefix);
      v6.push([first, first + ((1n << width) - 1n), cc]);
    }
  }

  return { v4, v6 };
}

/**
 * Packs parsed ranges into typed arrays, sorted by start address.
 *
 * There are roughly a third of a million allocations. Held as arrays of arrays
 * they cost about 77 MB of heap, which is more than the rest of this service
 * uses put together and an unreasonable thing to impose on someone self-hosting
 * on a small box. Three parallel typed arrays per family, with country codes
 * reduced to indices into a short list, bring the same data under 5 MB.
 *
 * @param {{v4: Array, v6: Array}} parsed
 * @returns {object} packed table
 */
function countryIndexer() {
  const countries = [];
  const indexOf = new Map();

  return {
    countries,
    codeFor(cc) {
      const existing = indexOf.get(cc);
      if (existing !== undefined) return existing;
      const next = countries.length;
      countries.push(cc);
      indexOf.set(cc, next);
      return next;
    },
  };
}

export function pack(parsed) {
  const { countries, codeFor } = countryIndexer();

  const side = (rows, StartArray) => {
    rows.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));

    const start = new StartArray(rows.length);
    const end = new StartArray(rows.length);
    const cc = new Uint16Array(rows.length);

    for (let i = 0; i < rows.length; i += 1) {
      start[i] = rows[i][0];
      end[i] = rows[i][1];
      cc[i] = codeFor(rows[i][2]);
    }
    return { start, end, cc };
  };

  return {
    v4: side(parsed.v4, Uint32Array),
    v6: side(parsed.v6, BigUint64Array),
    countries,
  };
}

/**
 * Fetches one registry's file, retrying a couple of times before giving up.
 *
 * A blip while fetching is otherwise expensive out of proportion to its cause:
 * the resulting table is missing a continent, and it gets cached.
 *
 * @param {string} url
 * @param {Function} fetchImpl
 * @returns {Promise<string>}
 */
async function fetchSource(url, fetchImpl) {
  let lastError;

  for (let attempt = 1; attempt <= FETCH_ATTEMPTS; attempt += 1) {
    try {
      const res = await fetchImpl(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (!res.ok) throw new Error(`responded ${res.status}`);
      return await res.text();
    } catch (error) {
      lastError = error;
      if (attempt < FETCH_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, attempt * 1_000));
      }
    }
  }

  throw new Error(`${lastError?.cause?.code ?? lastError?.message} after ${FETCH_ATTEMPTS} tries`);
}

/**
 * Fetches every registry and compiles one table.
 *
 * A single registry being unreachable degrades coverage rather than failing the
 * build: partial data still answers most lookups, and the next refresh can pick
 * up what was missed.
 *
 * @param {(url: string) => Promise<Response>} [fetchImpl]
 * @returns {Promise<{v4: Array, v6: Array, sources: number}>} unpacked ranges
 */
export async function buildTable(fetchImpl = fetch) {
  const v4 = [];
  const v6 = [];
  let sources = 0;

  // Only ever widened, never narrowed: if the host application has already
  // chosen a longer window, leave its choice alone.
  if (net.getDefaultAutoSelectFamilyAttemptTimeout() < FAMILY_ATTEMPT_TIMEOUT_MS) {
    net.setDefaultAutoSelectFamilyAttemptTimeout(FAMILY_ATTEMPT_TIMEOUT_MS);
  }

  const results = await Promise.allSettled(
    SOURCES.map(async (url) => parseDelegations(await fetchSource(url, fetchImpl))),
  );

  for (const [index, result] of results.entries()) {
    if (result.status !== 'fulfilled') {
      console.warn(`RIR source unavailable (${SOURCES[index]}): ${result.reason?.message}`);
      continue;
    }
    sources += 1;
    // Appended one at a time rather than by spreading. A registry file yields
    // well over a hundred thousand rows, and `push(...rows)` passes every one
    // as an argument, which overflows the stack once a file grows past V8's
    // argument limit.
    for (const row of result.value.v4) v4.push(row);
    for (const row of result.value.v6) v6.push(row);
  }

  return { v4, v6, sources };
}

/**
 * Serialises a packed table to a compact text cache.
 *
 * Written from the packed table rather than from the parsed rows so the file
 * inherits its sort order from the structure lookups actually use. The reader
 * relies on that ordering, and deriving both from the same place is what keeps
 * the two from drifting apart.
 *
 * Plain text rather than a binary blob: it costs a couple of hundred
 * milliseconds to read back at startup, and in exchange anyone wondering why a
 * response was attributed to a given country can grep the file and see the
 * allocation for themselves.
 *
 * @param {object} table packed table from {@link pack}
 * @param {number} sources how many registries answered when it was built
 * @returns {string}
 */
export function serialise(table, sources) {
  const lines = [`#v${CACHE_VERSION} built=${new Date().toISOString()} sources=${sources}`];

  for (let i = 0; i < table.v4.start.length; i += 1) {
    lines.push(`4,${table.v4.start[i]},${table.v4.end[i]},${table.countries[table.v4.cc[i]]}`);
  }
  for (let i = 0; i < table.v6.start.length; i += 1) {
    lines.push(`6,${table.v6.start[i]},${table.v6.end[i]},${table.countries[table.v6.cc[i]]}`);
  }

  return lines.join('\n');
}

/**
 * Reads a cache file straight into a packed table.
 *
 * This is the path taken on every restart between weekly refreshes, so it walks
 * the text twice - once to count each family, once to fill arrays allocated at
 * exactly the right size - rather than accumulating a third of a million
 * temporary rows and packing them afterwards. The file is already sorted,
 * because it was written from a sorted table.
 *
 * @param {string} text
 * @returns {object|null} packed table, or null when the cache is a version this
 *   build does not understand.
 */
export function deserialise(text) {
  const firstBreak = text.indexOf('\n');
  const header = firstBreak === -1 ? text : text.slice(0, firstBreak);
  if (!header.startsWith(`#v${CACHE_VERSION} `)) return null;

  // How many registries answered when this file was written. A file built while
  // one was down is missing that registry's allocations entirely.
  const sources = Number(/\bsources=(\d+)/.exec(header)?.[1] ?? 0);

  const FAMILY_V4 = 52; // '4'
  const FAMILY_V6 = 54; // '6'

  let v4Count = 0;
  let v6Count = 0;
  for (let at = firstBreak; at !== -1; at = text.indexOf('\n', at + 1)) {
    const family = text.charCodeAt(at + 1);
    if (family === FAMILY_V4) v4Count += 1;
    else if (family === FAMILY_V6) v6Count += 1;
  }

  const { countries, codeFor } = countryIndexer();
  const v4 = {
    start: new Uint32Array(v4Count),
    end: new Uint32Array(v4Count),
    cc: new Uint16Array(v4Count),
  };
  const v6 = {
    start: new BigUint64Array(v6Count),
    end: new BigUint64Array(v6Count),
    cc: new Uint16Array(v6Count),
  };

  let v4At = 0;
  let v6At = 0;
  for (let at = firstBreak; at !== -1; ) {
    const from = at + 1;
    at = text.indexOf('\n', from);
    const line = at === -1 ? text.slice(from) : text.slice(from, at);
    if (!line) continue;

    const [family, start, end, cc] = line.split(',');
    if (family === '4') {
      v4.start[v4At] = Number(start);
      v4.end[v4At] = Number(end);
      v4.cc[v4At] = codeFor(cc);
      v4At += 1;
    } else if (family === '6') {
      v6.start[v6At] = BigInt(start);
      v6.end[v6At] = BigInt(end);
      v6.cc[v6At] = codeFor(cc);
      v6At += 1;
    }
  }

  return { v4, v6, countries, sources };
}

/**
 * Binary search for the allocation containing a value.
 *
 * @param {{start: object, end: object, cc: Uint16Array}} side one packed family
 * @param {number|bigint} value must match the family's element type
 * @returns {number} country index, or -1 when no allocation covers it
 */
export function lookup(side, value) {
  let low = 0;
  let high = side.start.length - 1;

  while (low <= high) {
    const mid = (low + high) >> 1;
    if (value < side.start[mid]) high = mid - 1;
    else if (value > side.end[mid]) low = mid + 1;
    else return side.cc[mid];
  }
  return NO_MATCH;
}

/**
 * Resolves an address to a country code against a packed table.
 *
 * Lives here rather than alongside the request handling so it can be exercised
 * with a hand-built table, no configuration, no disk and no network.
 *
 * @param {object} table packed table from {@link pack}
 * @param {string} ip
 * @returns {string|null} country code, or null for private, malformed or
 *   unallocated addresses
 */
export function countryOfIp(table, ip) {
  if (!table || !ip) return null;

  // Node reports IPv4 clients over an IPv6 socket as ::ffff:1.2.3.4.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  const address = mapped ? mapped[1] : ip;

  let index;
  if (address.includes('.')) {
    const value = ipv4ToInt(address);
    if (value === null) return null;
    index = lookup(table.v4, value);
  } else {
    const value = ipv6ToHigh64(address);
    if (value === null) return null;
    index = lookup(table.v6, value);
  }

  return index === NO_MATCH ? null : (table.countries[index] ?? null);
}

/**
 * Loads the table, rebuilding it when absent or stale.
 *
 * The write goes to a temporary file and is renamed into place, so a process
 * killed mid-write cannot leave a half-written cache that the next start would
 * read as truth.
 *
 * @param {string} cacheDir
 * @param {number} maxAgeDays
 * @returns {Promise<object|null>} packed table, or null when no data could be
 *   obtained at all
 */
export async function loadTable(cacheDir, maxAgeDays) {
  const cachePath = join(cacheDir, 'rir-country-ranges.txt');

  try {
    const info = await stat(cachePath);
    const ageDays = (Date.now() - info.mtimeMs) / 86_400_000;
    if (ageDays < maxAgeDays) {
      const cached = deserialise(await readFile(cachePath, 'utf8'));
      const complete = cached && cached.sources >= SOURCES.length;
      if (cached && (complete || ageDays < PARTIAL_REFRESH_DAYS)) {
        if (!complete) {
          console.warn(
            `Country ranges were built from only ${cached.sources} of ${SOURCES.length} ` +
              'registries; some countries will read as unknown until the next refresh.',
          );
        }
        return cached;
      }
    }
  } catch {
    // No usable cache; fall through and build one.
  }

  const built = await buildTable();
  if (!built.sources) {
    console.warn('No RIR delegation data could be fetched; country lookup disabled.');
    return null;
  }

  const { sources } = built;
  const table = { ...pack(built), sources };

  if (sources < SOURCES.length) {
    console.warn(
      `Country ranges built from only ${sources} of ${SOURCES.length} registries; ` +
        'the missing ones will read as unknown, and this will be retried tomorrow.',
    );
  }

  // The unpacked rows are an order of magnitude larger than the packed table
  // and nothing needs them again. Dropping them here keeps them from sitting on
  // the heap while the cache file is built, which is the other peak.
  built.v4 = null;
  built.v6 = null;

  try {
    await mkdir(dirname(cachePath), { recursive: true });
    const temp = `${cachePath}.${process.pid}.tmp`;
    await writeFile(temp, serialise(table, sources), 'utf8');
    await rename(temp, cachePath);
  } catch (error) {
    // An unwritable cache is survivable: the table is already in memory, it
    // will just be rebuilt on the next start.
    console.warn(`Could not write the country range cache: ${error.message}`);
  }

  return table;
}
