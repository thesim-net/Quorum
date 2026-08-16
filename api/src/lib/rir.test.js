import assert from 'node:assert/strict';
import test from 'node:test';

import {
  countryOfIp,
  deserialise,
  ipv4ToInt,
  ipv6ToHigh64,
  lookup,
  pack,
  parseDelegations,
  serialise,
} from './rir.js';

test('parses dotted-quad IPv4', () => {
  assert.equal(ipv4ToInt('0.0.0.0'), 0);
  assert.equal(ipv4ToInt('1.2.3.4'), 16909060);
  assert.equal(ipv4ToInt('255.255.255.255'), 4294967295);
});

test('rejects malformed IPv4 rather than guessing', () => {
  assert.equal(ipv4ToInt('1.2.3'), null);
  assert.equal(ipv4ToInt('256.0.0.1'), null);
  assert.equal(ipv4ToInt('1.2.3.4.5'), null);
  assert.equal(ipv4ToInt('a.b.c.d'), null);
});

test('parses IPv6 down to its high 64 bits, including :: elision', () => {
  assert.equal(ipv6ToHigh64('2001:db8::'), 0x20010db800000000n);
  // The elided form and the written-out form must agree.
  assert.equal(ipv6ToHigh64('2001:0db8:0000:0000::'), ipv6ToHigh64('2001:db8::'));
  // Anything below the top 64 bits is deliberately ignored.
  assert.equal(ipv6ToHigh64('2001:db8::dead:beef'), ipv6ToHigh64('2001:db8::'));
});

test('derives IPv4 ranges from a host count, not a prefix', () => {
  // 1.0.0.0/24 is written as a count of 256, and some allocations are not a
  // power of two at all, so the end has to come from addition.
  const { v4 } = parseDelegations(
    'apnic|AU|ipv4|1.0.0.0|256|20110811|assigned\n' +
      'arin|US|ipv4|8.0.0.0|1000|19921201|allocated\n',
  );
  assert.deepEqual(v4[0], [ipv4ToInt('1.0.0.0'), ipv4ToInt('1.0.0.255'), 'AU']);
  assert.equal(v4[1][1] - v4[1][0], 999);
});

test('skips summary rows, reserved space and unallocated blocks', () => {
  const { v4, v6 } = parseDelegations(
    '2|apnic|20240101|12345|19830613|20240101|+1000\n' +
      'apnic|*|asn|1|100|summary\n' +
      'arin|ZZ|ipv4|10.0.0.0|256|19921201|reserved\n' +
      'arin|US|ipv4|11.0.0.0|256|19921201|available\n' +
      'ripencc|DE|ipv6|2a00::|12|20060801|allocated\n',
  );
  assert.equal(v4.length, 0, 'reserved and available rows must not become ranges');
  assert.equal(v6.length, 1);
  assert.equal(v6[0][2], 'DE');
});

test('packing sorts by start address regardless of input order', () => {
  const table = pack(
    parseDelegations(
      'arin|US|ipv4|200.0.0.0|256|19921201|allocated\n' +
        'apnic|AU|ipv4|1.0.0.0|256|20110811|allocated\n' +
        'ripencc|DE|ipv4|100.0.0.0|256|20060801|allocated\n',
    ),
  );
  assert.deepEqual(Array.from(table.v4.start), [
    ipv4ToInt('1.0.0.0'),
    ipv4ToInt('100.0.0.0'),
    ipv4ToInt('200.0.0.0'),
  ]);
  // Country codes are stored as indices into a short list, not repeated strings.
  assert.ok(table.v4.cc instanceof Uint16Array);
  assert.deepEqual(
    Array.from(table.v4.cc, (i) => table.countries[i]),
    ['AU', 'DE', 'US'],
  );
});

test('a cache survives a serialise and read-back round trip', () => {
  const table = pack(
    parseDelegations(
      'apnic|AU|ipv4|1.0.0.0|256|20110811|allocated\n' +
        'arin|US|ipv4|8.8.8.0|256|19921201|allocated\n' +
        'ripencc|DE|ipv6|2a00:1450::|32|20060801|allocated\n',
    ),
  );
  const readBack = deserialise(serialise(table, 5));

  assert.deepEqual(Array.from(readBack.v4.start), Array.from(table.v4.start));
  assert.deepEqual(Array.from(readBack.v4.end), Array.from(table.v4.end));
  assert.deepEqual(Array.from(readBack.v6.start), Array.from(table.v6.start));
  assert.deepEqual(Array.from(readBack.v6.end), Array.from(table.v6.end));
  // Country indices are rebuilt on read, so compare the resolved codes.
  assert.equal(countryOfIp(readBack, '8.8.8.8'), 'US');
  assert.equal(countryOfIp(readBack, '1.0.0.1'), 'AU');
  assert.equal(countryOfIp(readBack, '2a00:1450::1'), 'DE');
});

test('a written cache is sorted, because the reader binary-searches it', () => {
  // The rows go in out of order; what lands on disk must not be.
  const table = pack(
    parseDelegations(
      'arin|US|ipv4|200.0.0.0|256|19921201|allocated\n' +
        'apnic|AU|ipv4|1.0.0.0|256|20110811|allocated\n' +
        'ripencc|DE|ipv4|100.0.0.0|256|20060801|allocated\n',
    ),
  );
  const starts = serialise(table, 3)
    .split('\n')
    .slice(1)
    .map((line) => Number(line.split(',')[1]));

  assert.deepEqual(starts, [...starts].sort((a, b) => a - b));
  assert.equal(countryOfIp(deserialise(serialise(table, 3)), '100.0.0.1'), 'DE');
});

test('a cache from a different format version is rejected, not misread', () => {
  const empty = pack({ v4: [], v6: [] });
  assert.equal(deserialise(serialise(empty, 5).replace('#v1 ', '#v99 ')), null);
});

test('binary search finds the covering allocation and nothing else', () => {
  const side = {
    start: Uint32Array.from([100, 300, 500]),
    end: Uint32Array.from([199, 399, 599]),
    cc: Uint16Array.from([0, 1, 2]),
  };
  assert.equal(lookup(side, 100), 0);
  assert.equal(lookup(side, 150), 0);
  assert.equal(lookup(side, 199), 0);
  assert.equal(lookup(side, 599), 2);
  // Gaps between allocations must not be attributed to a neighbour.
  assert.equal(lookup(side, 250), -1);
  assert.equal(lookup(side, 99), -1);
  assert.equal(lookup(side, 600), -1);
});

test('resolves addresses against a table, including IPv4-mapped IPv6', () => {
  // Built through the real parser so the test cannot disagree with the format
  // the registries actually publish.
  const table = pack(
    parseDelegations(
      'arin|US|ipv4|8.8.8.0|256|19921201|allocated\n' +
        'ripencc|DE|ipv6|2a00:1450::|32|20060801|allocated\n',
    ),
  );

  assert.equal(countryOfIp(table, '8.8.8.8'), 'US');
  // Node hands IPv4 clients on an IPv6 socket to us in this form.
  assert.equal(countryOfIp(table, '::ffff:8.8.8.8'), 'US');
  assert.equal(countryOfIp(table, '2a00:1450:4001:1::1'), 'DE');
  // A neighbouring allocation is a different country; the /32 must not spill.
  assert.equal(countryOfIp(table, '2a00:1451::1'), null);
});

test('private and unroutable addresses resolve to nothing', () => {
  const table = pack(parseDelegations('arin|US|ipv4|8.8.8.0|256|19921201|allocated\n'));
  // A LAN address is what you get when the proxy hop count is wrong; it must
  // read as unknown rather than being attributed to whoever holds that range.
  assert.equal(countryOfIp(table, '192.168.0.1'), null);
  assert.equal(countryOfIp(table, '127.0.0.1'), null);
  assert.equal(countryOfIp(table, 'not-an-ip'), null);
  assert.equal(countryOfIp(table, ''), null);
  assert.equal(countryOfIp(null, '8.8.8.8'), null);
});

test('an allocation running past the end of the address space is dropped', () => {
  // Stored in a Uint32Array this would wrap to an end below its start, and the
  // binary search would then stop dead at that row for every address above it.
  const { v4 } = parseDelegations(
    'arin|US|ipv4|255.255.255.0|512|19921201|allocated\n' +
      'apnic|AU|ipv4|1.0.0.0|256|20110811|allocated\n',
  );
  assert.equal(v4.length, 1);
  assert.equal(v4[0][2], 'AU');
});

test('the first allocation is reachable, whichever country holds it', () => {
  // Index 0 is both a valid country index and the natural sentinel value, so a
  // lookup landing on the very first range has to come back as a real answer.
  const table = pack(parseDelegations('apnic|AU|ipv4|1.0.0.0|256|20110811|allocated\n'));
  assert.equal(countryOfIp(table, '1.0.0.1'), 'AU');
});
