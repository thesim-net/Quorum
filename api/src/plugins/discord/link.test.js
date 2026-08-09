import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CALLBACK_ACTIONS,
  INTENTS,
  decodeState,
  encodeState,
  resolveCallback,
  resolveLink,
} from './link.js';

const OWNER = 'user-owner';
const OTHER = 'user-other';

test('the intent survives a round trip through the state parameter', () => {
  const state = encodeState(INTENTS.LINK, 'aBc-123_xyz');
  assert.deepEqual(decodeState(state), { intent: INTENTS.LINK, token: 'aBc-123_xyz' });
  assert.deepEqual(decodeState(encodeState(INTENTS.SIGN_IN, 'tok')), {
    intent: INTENTS.SIGN_IN,
    token: 'tok',
  });
});

test('the respondent intent round trips like the others', () => {
  const state = encodeState(INTENTS.RESPONDENT, 'tok');
  assert.deepEqual(decodeState(state), { intent: INTENTS.RESPONDENT, token: 'tok' });
});

test('an unknown intent is never encoded, and never decoded', () => {
  assert.equal(decodeState(encodeState('elevate', 'tok')).intent, INTENTS.SIGN_IN);
  assert.equal(decodeState('elevate.tok'), null);
  assert.equal(decodeState('link'), null);
  assert.equal(decodeState('link.'), null);
  assert.equal(decodeState(''), null);
  assert.equal(decodeState(undefined), null);
});

test('an unknown Discord id signs nobody in and creates no account', () => {
  const outcome = resolveCallback({ intent: INTENTS.SIGN_IN, existingUserId: null });
  assert.equal(outcome.action, CALLBACK_ACTIONS.NO_ACCOUNT);
  assert.equal(outcome.userId, null);
});

test('a known Discord id signs in as that account', () => {
  const outcome = resolveCallback({ intent: INTENTS.SIGN_IN, existingUserId: OWNER });
  assert.equal(outcome.action, CALLBACK_ACTIONS.SIGN_IN);
  assert.equal(outcome.userId, OWNER);
});

test('a bootstrap admin id is the one exception that may mint an account', () => {
  const outcome = resolveCallback({
    intent: INTENTS.SIGN_IN,
    existingUserId: null,
    isBootstrapAdmin: true,
  });
  assert.equal(outcome.action, CALLBACK_ACTIONS.CREATE_BOOTSTRAP);

  // Once that account exists it is an ordinary sign-in, not another create.
  assert.equal(
    resolveCallback({ intent: INTENTS.SIGN_IN, existingUserId: OWNER, isBootstrapAdmin: true })
      .action,
    CALLBACK_ACTIONS.SIGN_IN,
  );
});

test('a link attaches to the signed-in account, never to the id\'s owner', () => {
  const outcome = resolveCallback({
    intent: INTENTS.LINK,
    signedInUserId: OWNER,
    existingUserId: OTHER,
  });
  assert.equal(outcome.action, CALLBACK_ACTIONS.LINK);
  assert.equal(outcome.userId, OWNER);
});

test('a link with nobody signed in creates nothing and switches to nobody', () => {
  const outcome = resolveCallback({
    intent: INTENTS.LINK,
    signedInUserId: null,
    existingUserId: OTHER,
  });
  assert.equal(outcome.action, CALLBACK_ACTIONS.LINK_SIGNED_OUT);
  assert.equal(outcome.userId, null);
});

test('taking a survey resolves to an identity and never to an account', () => {
  // Whoever holds the id, and whether they are signed in here, is beside the
  // point: a respondent is not an account, and none is created, found, or
  // switched to.
  for (const context of [
    { existingUserId: null },
    { existingUserId: OTHER },
    { signedInUserId: OWNER, existingUserId: OWNER },
    { existingUserId: null, isBootstrapAdmin: true },
  ]) {
    const outcome = resolveCallback({ intent: INTENTS.RESPONDENT, ...context });
    assert.equal(outcome.action, CALLBACK_ACTIONS.RESPONDENT);
    assert.equal(outcome.userId, null);
  }
});

test('a free Discord id is attached to the caller', () => {
  assert.deepEqual(resolveLink({ signedInUserId: OWNER, ownerUserId: null }), {
    ok: true,
    status: 200,
    error: null,
    changed: true,
  });
});

test('a Discord id held by another account is refused with a clean 409', () => {
  const outcome = resolveLink({ signedInUserId: OWNER, ownerUserId: OTHER });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.status, 409);
  assert.equal(outcome.error, 'That Discord account is already linked to another user.');
  assert.equal(outcome.changed, false);
});

test('re-linking the id an account already holds is a no-op, not a failure', () => {
  const outcome = resolveLink({ signedInUserId: OWNER, ownerUserId: OWNER });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.changed, false);
});
