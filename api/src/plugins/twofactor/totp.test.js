import test from 'node:test';
import assert from 'node:assert/strict';
import { base32Decode, base32Encode, hotp, otpauthUri, totp, verifyTotp } from './totp.js';

// The RFC 6238 appendix B secret for SHA-1.
const SECRET = Buffer.from('12345678901234567890', 'ascii');

test('hotp matches the RFC 4226 appendix D vectors', () => {
  const expected = ['755224', '287082', '359152', '969429', '338314', '254676'];
  for (const [counter, code] of expected.entries()) {
    assert.equal(hotp(SECRET, counter), code);
  }
});

test('totp matches the RFC 6238 appendix B vectors truncated to six digits', () => {
  // Appendix B lists 8-digit SHA-1 codes; the low six digits are what a
  // 6-digit generator produces for the same secret and time.
  const vectors = [
    [59, '287082'],
    [1111111109, '081804'],
    [1111111111, '050471'],
    [1234567890, '005924'],
    [2000000000, '279037'],
    [20000000000, '353130'],
  ];
  for (const [seconds, code] of vectors) {
    assert.equal(totp(SECRET, { timeMs: seconds * 1000 }), code);
  }
});

test('verifyTotp accepts one step of clock drift either way and no more', () => {
  const timeMs = 1111111111 * 1000;
  const previous = totp(SECRET, { timeMs: timeMs - 30_000 });
  const following = totp(SECRET, { timeMs: timeMs + 30_000 });
  const stale = totp(SECRET, { timeMs: timeMs - 60_000 });

  assert.equal(verifyTotp(SECRET, totp(SECRET, { timeMs }), { timeMs }), true);
  assert.equal(verifyTotp(SECRET, previous, { timeMs }), true);
  assert.equal(verifyTotp(SECRET, following, { timeMs }), true);
  assert.equal(verifyTotp(SECRET, stale, { timeMs }), false);
});

test('verifyTotp tolerates whitespace and rejects malformed codes', () => {
  const timeMs = 59 * 1000;
  assert.equal(verifyTotp(SECRET, ' 287 082 ', { timeMs }), true);
  assert.equal(verifyTotp(SECRET, '28708', { timeMs }), false);
  assert.equal(verifyTotp(SECRET, '2870820', { timeMs }), false);
  assert.equal(verifyTotp(SECRET, 'abcdef', { timeMs }), false);
  assert.equal(verifyTotp(SECRET, '', { timeMs }), false);
  assert.equal(verifyTotp(SECRET, null, { timeMs }), false);
});

test('base32 round-trips arbitrary bytes', () => {
  const cases = [
    Buffer.alloc(0),
    Buffer.from([0]),
    Buffer.from([255]),
    Buffer.from('f'),
    Buffer.from('fo'),
    Buffer.from('foo'),
    Buffer.from('foob'),
    Buffer.from('fooba'),
    Buffer.from('foobar'),
    SECRET,
    Buffer.from(Array.from({ length: 20 }, (_, i) => (i * 37) % 256)),
  ];
  for (const buffer of cases) {
    assert.deepEqual(base32Decode(base32Encode(buffer)), buffer);
  }
});

test('base32Encode matches the RFC 4648 vectors, unpadded', () => {
  assert.equal(base32Encode(Buffer.from('')), '');
  assert.equal(base32Encode(Buffer.from('f')), 'MY');
  assert.equal(base32Encode(Buffer.from('fo')), 'MZXQ');
  assert.equal(base32Encode(Buffer.from('foo')), 'MZXW6');
  assert.equal(base32Encode(Buffer.from('foob')), 'MZXW6YQ');
  assert.equal(base32Encode(Buffer.from('fooba')), 'MZXW6YTB');
  assert.equal(base32Encode(Buffer.from('foobar')), 'MZXW6YTBOI');
});

test('base32Decode tolerates case, padding and spaces, and rejects junk', () => {
  assert.deepEqual(base32Decode('mzxw6ytboi'), Buffer.from('foobar'));
  assert.deepEqual(base32Decode('MZXW6YQ='), Buffer.from('foob'));
  assert.deepEqual(base32Decode('MZXW 6YTB OI'), Buffer.from('foobar'));
  assert.throws(() => base32Decode('MZXW1'));
});

test('otpauthUri carries the label, secret and issuer', () => {
  const uri = otpauthUri('sam wise', 'MZXW6YTBOI');
  assert.equal(uri, 'otpauth://totp/Quorum:sam%20wise?secret=MZXW6YTBOI&issuer=Quorum');
});
