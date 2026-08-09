import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/**
 * Migrations are applied to a live database, so the rules they carry cannot be
 * exercised from a unit test. What can be checked, and is worth checking, is
 * that the rules are still stated: a backfill quietly dropped in a later edit
 * would silently change what every existing survey does on the next deploy,
 * which is exactly the kind of change nobody reviews twice.
 *
 * @param {string} name Migration filename.
 * @returns {string} The SQL with comments removed and whitespace flattened.
 */
function migration(name) {
  return readFileSync(new URL(`./migrations/${name}`, import.meta.url), 'utf8')
    .replace(/^\s*--.*$/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const GUILD_GATE = migration('013_guild_gate.sql');

test('013 adds the guild gate switched off, so nothing becomes gated by surprise', () => {
  assert.match(
    GUILD_GATE,
    /ALTER TABLE surveys ADD COLUMN require_guild boolean NOT NULL DEFAULT false/,
  );
});

test('013 backfills every previously restricted survey as gated', () => {
  // A survey that named a role or a channel was gated before this migration and
  // must stay gated after it. Losing this line would reopen every one of them
  // to anyone holding the link.
  assert.match(
    GUILD_GATE,
    /UPDATE surveys SET require_guild = true WHERE array_length\(gate_role_ids, 1\) > 0 OR array_length\(gate_channel_ids, 1\) > 0/,
  );
});

test('013 keeps the role and channel lists, which become the narrowing', () => {
  assert.doesNotMatch(GUILD_GATE, /DROP COLUMN gate_role_ids/);
  assert.doesNotMatch(GUILD_GATE, /DROP COLUMN gate_channel_ids/);
});

test('013 defaults every survey to one response per person', () => {
  // The default is the whole backfill: existing surveys behaved this way, so
  // they carry on behaving this way with no UPDATE at all.
  assert.match(
    GUILD_GATE,
    /ALTER TABLE surveys ADD COLUMN one_response_per_person boolean NOT NULL DEFAULT true/,
  );
  assert.doesNotMatch(GUILD_GATE, /UPDATE surveys SET one_response_per_person/);
});

test('013 leaves the one-response guarantee in the database, not in a code path', () => {
  // Two simultaneous submissions are adjudicated by this index. Replacing it
  // with an application check would make the second one a race.
  assert.match(GUILD_GATE, /ALTER TABLE responses ADD COLUMN exclusive boolean NOT NULL DEFAULT true/);
  assert.match(
    GUILD_GATE,
    /CREATE UNIQUE INDEX responses_one_per_respondent_idx ON responses \(survey_id, respondent_hash\) WHERE exclusive/,
  );
  // The unconditional constraint it replaces has to go, or a survey that allows
  // repeats could never store the second response.
  assert.match(
    GUILD_GATE,
    /ALTER TABLE responses DROP CONSTRAINT IF EXISTS responses_survey_id_respondent_hash_key/,
  );
});
