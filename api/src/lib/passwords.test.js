import test from 'node:test';
import assert from 'node:assert/strict';
import { generatePassword, hashPassword, verifyPassword } from './passwords.js';

test('hashPassword produces the documented format and verifies', async () => {
  const stored = await hashPassword('correct horse battery staple');

  const parts = stored.split('$');
  assert.equal(parts.length, 6);
  assert.equal(parts[0], 'scrypt');
  assert.deepEqual(parts.slice(1, 4).map(Number), [16384, 8, 1]);
  // 32-byte salt and 64-byte key, both base64.
  assert.equal(Buffer.from(parts[4], 'base64').length, 32);
  assert.equal(Buffer.from(parts[5], 'base64').length, 64);

  assert.equal(await verifyPassword('correct horse battery staple', stored), true);
  assert.equal(await verifyPassword('correct horse battery stapl', stored), false);
  assert.equal(await verifyPassword('', stored), false);
});

test('hashPassword salts every hash', async () => {
  const a = await hashPassword('same password');
  const b = await hashPassword('same password');
  assert.notEqual(a, b);
  assert.equal(await verifyPassword('same password', a), true);
  assert.equal(await verifyPassword('same password', b), true);
});

test('verifyPassword rejects malformed stored values without throwing', async () => {
  assert.equal(await verifyPassword('x', null), false);
  assert.equal(await verifyPassword('x', ''), false);
  assert.equal(await verifyPassword('x', 'bcrypt$whatever'), false);
  assert.equal(await verifyPassword('x', 'scrypt$0$8$1$AA==$AA=='), false);
  assert.equal(await verifyPassword('x', 'scrypt$16384$8$1$AA=='), false);
});

test('generatePassword returns distinct URL-safe passwords', () => {
  const a = generatePassword();
  const b = generatePassword();
  assert.notEqual(a, b);
  assert.match(a, /^[A-Za-z0-9_-]{16}$/);
});
