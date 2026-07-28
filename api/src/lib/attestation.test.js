import test from 'node:test';
import assert from 'node:assert/strict';
import { formatStatus } from './attestation.js';
import { classifyPlugins } from './plugins.js';

test('formatStatus builds the ghcr image and verify commands from the repo', () => {
  const s = formatStatus('verified', 'sha256:abc');
  assert.equal(s.state, 'verified');
  assert.equal(s.digest, 'sha256:abc');
  assert.equal(s.image, 'ghcr.io/thomasloupe/quorum-api');
  assert.match(s.verify.api, /oci:\/\/ghcr\.io\/thomasloupe\/quorum-api:/);
  assert.match(s.verify.web, /oci:\/\/ghcr\.io\/thomasloupe\/quorum-web:/);
  assert.match(s.verify.api, /--repo thomasloupe\/Quorum$/);
  assert.equal(s.attestationUrl, 'https://github.com/thomasloupe/Quorum/attestations');
});

test('formatStatus carries a null digest through for unverifiable states', () => {
  const s = formatStatus('local', null);
  assert.equal(s.state, 'local');
  assert.equal(s.digest, null);
});

test('classifyPlugins reports enabled built-ins as official', () => {
  const { official, custom } = classifyPlugins({ raffle: true, quotas: false, conditional: true });
  assert.deepEqual(
    official.map((p) => p.key).sort(),
    ['conditional', 'raffle'],
  );
  assert.equal(custom.length, 0);
  // Names come from the catalogue so the page can label them.
  assert.ok(official.every((p) => typeof p.name === 'string' && p.name.length));
});

test('classifyPlugins discloses an enabled unlisted plugin as custom', () => {
  const { official, custom } = classifyPlugins({ raffle: true, 'acme-extra': true });
  assert.deepEqual(official.map((p) => p.key), ['raffle']);
  assert.deepEqual(custom, ['acme-extra']);
});

test('classifyPlugins ignores disabled plugins and empty input', () => {
  assert.deepEqual(classifyPlugins({ raffle: false }), { official: [], custom: [] });
  assert.deepEqual(classifyPlugins(null), { official: [], custom: [] });
});
