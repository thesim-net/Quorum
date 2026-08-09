import test from 'node:test';
import assert from 'node:assert/strict';
import { ONBOARDING_STEPS, canUnlinkDiscord, onboardingState } from './onboarding.js';

// A Discord-capable deployment, with an admin who holds neither identity yet.
const base = {
  isAdmin: true,
  hasPassword: false,
  hasDiscordId: false,
  discordReady: true,
  exempt: false,
};

test('an admin missing both is asked for credentials first, and only that', () => {
  const state = onboardingState(base);
  assert.equal(state.step, ONBOARDING_STEPS.CREDENTIALS);
  assert.equal(state.mustSetCredentials, true);
  assert.equal(state.mustLinkDiscord, false);
});

test('the two gates are never both on at once', () => {
  for (const hasPassword of [true, false]) {
    for (const hasDiscordId of [true, false]) {
      for (const discordReady of [true, false]) {
        const state = onboardingState({ ...base, hasPassword, hasDiscordId, discordReady });
        assert.equal(
          state.mustSetCredentials && state.mustLinkDiscord,
          false,
          `both gates fired for ${JSON.stringify({ hasPassword, hasDiscordId, discordReady })}`,
        );
      }
    }
  }
});

test('an account missing both is complete after doing each step once', () => {
  // Step one: set a username and password.
  let state = onboardingState(base);
  assert.equal(state.step, ONBOARDING_STEPS.CREDENTIALS);

  // Step two: link Discord. Satisfying the first does not re-ask for it.
  const withPassword = { ...base, hasPassword: true };
  state = onboardingState(withPassword);
  assert.equal(state.step, ONBOARDING_STEPS.DISCORD_LINK);
  assert.equal(state.mustSetCredentials, false);

  // Done. Linking does not send them back to the credentials step.
  state = onboardingState({ ...withPassword, hasDiscordId: true });
  assert.equal(state.step, null);
  assert.deepEqual(
    [state.mustSetCredentials, state.mustLinkDiscord],
    [false, false],
  );
});

test('a Discord admin with no password is asked for credentials, not for a link', () => {
  const state = onboardingState({ ...base, hasDiscordId: true });
  assert.equal(state.step, ONBOARDING_STEPS.CREDENTIALS);
  assert.equal(state.mustLinkDiscord, false);
});

test('the link gate is off while the plugin is disabled or unconfigured', () => {
  const state = onboardingState({ ...base, hasPassword: true, discordReady: false });
  assert.equal(state.step, null);
  assert.equal(state.mustLinkDiscord, false);
  // A single-auth deployment is a one-step flow, not a two-step one with an
  // unreachable second step.
  assert.deepEqual(state.steps, [ONBOARDING_STEPS.CREDENTIALS]);
});

test('a Discord-capable deployment reports both steps', () => {
  assert.deepEqual(onboardingState(base).steps, [
    ONBOARDING_STEPS.CREDENTIALS,
    ONBOARDING_STEPS.DISCORD_LINK,
  ]);
});

test('someone who cannot reach the panel is never gated', () => {
  const state = onboardingState({ ...base, isAdmin: false });
  assert.equal(state.step, null);
  assert.deepEqual(state.steps, []);
});

test('the dev bypass is exempt from the whole flow', () => {
  const state = onboardingState({ ...base, exempt: true });
  assert.equal(state.step, null);
  assert.deepEqual(state.steps, []);
});

test('unlinking is refused when it would strip the last sign-in method', () => {
  assert.equal(canUnlinkDiscord({ hasPassword: false }), false);
  assert.equal(canUnlinkDiscord({ hasPassword: true }), true);
});
