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
const DROP_USER_PERMISSIONS = migration('014_drop_user_permissions.sql');
const GROUP_ADMINS = migration('015_group_admins.sql');

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

test('014 drops the per-user permission list', () => {
  assert.match(DROP_USER_PERMISSIONS, /ALTER TABLE users DROP COLUMN permissions/);
});

test('014 leaves group membership and the group permission columns alone', () => {
  // Membership IS the permission model now. 010 already moved every plain admin
  // into the default group; touching either here would take access away rather
  // than tidy a column nobody reads.
  assert.doesNotMatch(DROP_USER_PERMISSIONS, /group_members/);
  assert.doesNotMatch(DROP_USER_PERMISSIONS, /member_permissions/);
  assert.doesNotMatch(DROP_USER_PERMISSIONS, /group_grants/);
});

test('015 puts group administration on the membership, defaulted off', () => {
  // On the membership, not the account: that is the whole design, and moving it
  // to users would silently turn "administers Selections" into "administers
  // every group they are in". The default is the entire backfill - nobody
  // administered a group before this migration.
  assert.match(
    GROUP_ADMINS,
    /ALTER TABLE group_members ADD COLUMN is_admin boolean NOT NULL DEFAULT false/,
  );
  assert.doesNotMatch(GROUP_ADMINS, /ALTER TABLE users/);
  assert.doesNotMatch(GROUP_ADMINS, /UPDATE group_members/);
});

test('015 leaves the tier enum alone, so tier ordering is untouched', () => {
  // Group administration is not a tier. Had it become one, `ORDER BY tier DESC`
  // in the admins listing and resolveTier's comparisons would both have had to
  // learn about it; keeping it off the enum is what makes that a non-question.
  assert.doesNotMatch(GROUP_ADMINS, /ALTER TYPE/);
  assert.doesNotMatch(GROUP_ADMINS, /admin_tier/);
});
