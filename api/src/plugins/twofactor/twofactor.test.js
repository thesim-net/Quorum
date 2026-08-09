import test from 'node:test';
import assert from 'node:assert/strict';
import { effectiveRequirement } from './policy.js';

const base = {
  pluginEnabled: true,
  requireAllAdmins: false,
  isAdmin: true,
  totpRequired: false,
  enrolled: false,
};

test('nothing is required while the plugin is disabled', () => {
  assert.equal(
    effectiveRequirement({ ...base, pluginEnabled: false, requireAllAdmins: true, totpRequired: true, enrolled: true }),
    false,
  );
});

test('the global switch forces an admin that is not otherwise flagged', () => {
  assert.equal(effectiveRequirement({ ...base, requireAllAdmins: true }), true);
});

test('the global switch does not touch a non-admin', () => {
  assert.equal(effectiveRequirement({ ...base, requireAllAdmins: true, isAdmin: false }), false);
});

test('with the global switch off it falls back to the per-account flag', () => {
  assert.equal(effectiveRequirement({ ...base, totpRequired: true }), true);
  assert.equal(effectiveRequirement({ ...base, totpRequired: false }), false);
});

test('an already-enrolled account keeps being challenged even when unflagged', () => {
  assert.equal(effectiveRequirement({ ...base, enrolled: true }), true);
});
