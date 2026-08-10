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
const SURVEY_GROUPS = migration('016_survey_groups.sql');

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

test('016 moves every survey into the join table before dropping the column', () => {
  // The order is the whole of it: reading surveys.group_id after dropping it
  // would fail, and dropping it first would lose every survey's ownership.
  const copied = SURVEY_GROUPS.indexOf(
    'INSERT INTO survey_groups (survey_id, group_id) SELECT id, group_id FROM surveys',
  );
  const dropped = SURVEY_GROUPS.indexOf('ALTER TABLE surveys DROP COLUMN group_id');

  assert.ok(copied > 0, 'existing surveys are no longer copied into survey_groups');
  assert.ok(dropped > copied, 'surveys.group_id is dropped before it has been read');
});

test('016 keeps every gated survey gated, by gating its groups', () => {
  // Losing this makes every restricted survey public on the next deploy, which
  // is the one mistake this migration must never make.
  assert.match(
    SURVEY_GROUPS,
    /UPDATE groups g SET require_guild = true WHERE EXISTS \( SELECT 1 FROM survey_groups sg JOIN surveys s ON s\.id = sg\.survey_id WHERE sg\.group_id = g\.id AND s\.require_guild \)/,
  );
});

test('016 unions the narrowing lists into the group, from gated surveys only', () => {
  // An ungated survey's leftover lists were never evaluated, so carrying them
  // across would invent a restriction rather than preserve one.
  for (const column of ['gate_role_ids', 'gate_channel_ids']) {
    const single = column === 'gate_role_ids' ? 'role_id' : 'channel_id';
    assert.match(
      SURVEY_GROUPS,
      new RegExp(
        `UPDATE groups g SET ${column} = u\\.\\w+ FROM \\( SELECT sg\\.group_id, ` +
          `array_agg\\(DISTINCT ${single}\\) AS \\w+ FROM survey_groups sg JOIN surveys s ` +
          `ON s\\.id = sg\\.survey_id CROSS JOIN LATERAL unnest\\(s\\.${column}\\) AS ${single} ` +
          'WHERE s\\.require_guild GROUP BY sg\\.group_id \\) u WHERE u\\.group_id = g\\.id',
      ),
    );
  }
});

test('016 gives the groups their audience before taking the surveys\' away', () => {
  const backfilled = SURVEY_GROUPS.lastIndexOf('WHERE u.group_id = g.id');
  for (const column of ['require_guild', 'gate_role_ids', 'gate_channel_ids']) {
    const dropped = SURVEY_GROUPS.indexOf(`ALTER TABLE surveys DROP COLUMN ${column}`);
    assert.ok(dropped > backfilled, `surveys.${column} is dropped before it has been read`);
  }
});

test('016 drops the default flag and nothing else about the group that held it', () => {
  // The CONCEPT goes; the group survives as an ordinary one. On this deployment
  // that group is "Public", which is in daily use - deleting the row rather
  // than the column would take a real group's surveys with it.
  assert.match(SURVEY_GROUPS, /ALTER TABLE groups DROP COLUMN is_default/);
  assert.doesNotMatch(SURVEY_GROUPS, /DELETE FROM groups/);
  assert.doesNotMatch(SURVEY_GROUPS, /DROP TABLE groups/);
});

test('016 clears the group memberships super administrators hold', () => {
  // They reach every group already, so a membership grants them nothing and
  // only implies their access comes from that group - which stops being an
  // idle inaccuracy the moment the default fallback is gone.
  assert.match(
    SURVEY_GROUPS,
    /DELETE FROM group_members m USING users u WHERE u\.id = m\.user_id AND u\.tier = 'super_admin'/,
  );
});

test('016 adds somewhere for Discord-derived admins to land, defaulting to nowhere', () => {
  // Nullable and unset: with no group chosen those accounts get no access,
  // rather than a guessed one. A DEFAULT here would be exactly that guess.
  assert.match(
    SURVEY_GROUPS,
    /ALTER TABLE app_settings ADD COLUMN discord_admin_group_id uuid REFERENCES groups\(id\) ON DELETE SET NULL/,
  );
  assert.doesNotMatch(SURVEY_GROUPS, /discord_admin_group_id uuid[^;]*DEFAULT/);
});

test('016 leaves responses and answers untouched', () => {
  // Who a survey is for changed; what people answered did not. A survey moving
  // between groups must never disturb a response already given.
  assert.doesNotMatch(SURVEY_GROUPS, /\bresponses\b/);
  assert.doesNotMatch(SURVEY_GROUPS, /\banswers\b/);
});
