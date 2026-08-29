import test from 'node:test';
import assert from 'node:assert/strict';
import { recordsIdentity, respondentHash, respondentIdentity } from './respondent.js';

// The pepper is read from the environment on each call, so it is set here
// rather than requiring a whole runtime configuration to hash anything.
process.env.RESPONDENT_PEPPER = 'test-pepper';

const COOKIE_ID = '1a0b0c0d-0000-4000-8000-000000000001';
const DISCORD_ID = '900000000000000001';

const KEY_A = Buffer.alloc(32, 1);
const KEY_B = Buffer.alloc(32, 2);

const anonymous = { require_guild: false, respondent_key: KEY_A };
const gated = { require_guild: true, respondent_key: KEY_A };

test('an anonymous survey counts browsers, exactly as it always has', () => {
  assert.equal(
    respondentIdentity(anonymous, { cookieId: COOKIE_ID, discordId: DISCORD_ID }),
    COOKIE_ID,
  );

  // Even with a Discord identity to hand, an unchecked survey ignores it.
  assert.equal(
    respondentHash(KEY_A, respondentIdentity(anonymous, { cookieId: COOKIE_ID, discordId: DISCORD_ID })).toString('hex'),
    respondentHash(KEY_A, COOKIE_ID).toString('hex'),
  );
});

test('a gated survey counts Discord accounts instead', () => {
  assert.equal(
    respondentIdentity(gated, { cookieId: COOKIE_ID, discordId: DISCORD_ID }),
    DISCORD_ID,
  );

  const hash = respondentHash(KEY_A, respondentIdentity(gated, { cookieId: COOKIE_ID, discordId: DISCORD_ID }));
  assert.deepEqual(hash, respondentHash(KEY_A, DISCORD_ID));

  // Clearing the browser cookie no longer buys a second response.
  assert.notDeepEqual(hash, respondentHash(KEY_A, COOKIE_ID));
});

test('a gated survey with no proved identity yields nothing to hash', () => {
  assert.equal(respondentIdentity(gated, { cookieId: COOKIE_ID, discordId: null }), null);
});

test('the same Discord account hashes differently in every survey', () => {
  assert.notDeepEqual(respondentHash(KEY_A, DISCORD_ID), respondentHash(KEY_B, DISCORD_ID));
});

test('the hash is stable for the same person and survey', () => {
  assert.deepEqual(respondentHash(KEY_A, DISCORD_ID), respondentHash(KEY_A, DISCORD_ID));
  assert.equal(respondentHash(KEY_A, DISCORD_ID).length, 32);
});

test('a gated survey that collects identity records the name behind the response', () => {
  assert.equal(recordsIdentity({ ...gated, collect_identity: true }), true);
});

test('a survey that collects no identity records none, gated or not', () => {
  assert.equal(recordsIdentity({ ...gated, collect_identity: false }), false);
  assert.equal(recordsIdentity({ ...anonymous, collect_identity: false }), false);
});

test('an anonymous survey records no name even when it asks for identity', () => {
  // It counts browsers, so there is no person behind the hash to name. This is
  // the case where recording something would mean inventing it.
  assert.equal(recordsIdentity({ ...anonymous, collect_identity: true }), false);
});

test('the decision never consults a session', () => {
  // The original bug: identity was written only when `req.user` was set, which
  // no genuine respondent ever has. Nothing about a signed-in admin may change
  // the answer here.
  const survey = { ...gated, collect_identity: true };
  assert.equal(recordsIdentity(survey), recordsIdentity({ ...survey, user: { id: 'someone' } }));
});

test('a survey row with nothing on it records nothing rather than throwing', () => {
  assert.equal(recordsIdentity({}), false);
  assert.equal(recordsIdentity(null), false);
});
