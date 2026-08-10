-- Surveys belong to groups, and the audience rules move onto the group.
--
-- Until now a survey named one owning group and carried its own guild gate. Both
-- change here. A survey belongs to one or more groups through a join table, and
-- "who may take our surveys" - guild membership, role narrowing, channel
-- narrowing - becomes a property of the GROUP. A respondent may take a survey
-- when they satisfy at least one of its groups, so a survey placed on Astro and
-- on a wide-open Public group is takeable by anyone, while one placed on Astro
-- alone is takeable only by Astro's audience.
--
-- The default group goes with it. It existed to give an admin in no group
-- something to resolve against; that fallback is deliberately removed, so the
-- concept has nothing left to do. The GROUP that happens to be marked default
-- survives untouched as an ordinary group - on this deployment it is "Public",
-- which is a real group in daily use.

-- ---------------------------------------------------------------------------
-- A survey belongs to one or more groups
-- ---------------------------------------------------------------------------
--
-- "At least one group" cannot be stated here: a row of this table cannot see
-- whether it is the last one for its survey, and the check would need a trigger
-- to hold across two tables. It is enforced in the API instead - creation
-- refuses an empty list, and an update refuses to remove the last group.

CREATE TABLE survey_groups (
    survey_id uuid NOT NULL REFERENCES surveys(id) ON DELETE CASCADE,
    group_id  uuid NOT NULL REFERENCES groups(id)  ON DELETE CASCADE,
    added_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (survey_id, group_id)
);

-- "Which surveys belong to this group" is asked on every admin listing and on
-- every attempt to delete a group.
CREATE INDEX survey_groups_group_id_idx ON survey_groups(group_id);

-- Every existing survey keeps exactly the group it already had. Done before the
-- column is dropped, and before the audience backfill below reads it.
INSERT INTO survey_groups (survey_id, group_id)
SELECT id, group_id FROM surveys WHERE group_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- The audience moves from the survey to the group
-- ---------------------------------------------------------------------------

ALTER TABLE groups ADD COLUMN require_guild    boolean NOT NULL DEFAULT false;
ALTER TABLE groups ADD COLUMN gate_role_ids    text[] NOT NULL DEFAULT '{}';
ALTER TABLE groups ADD COLUMN gate_channel_ids text[] NOT NULL DEFAULT '{}';

-- Nothing may become more open than it is today. A group holding a gated survey
-- becomes gated, so the survey stays behind the same guild check it was
-- published with. Without this every restricted survey would open to anyone
-- holding the link on the next deploy.
UPDATE groups g
   SET require_guild = true
 WHERE EXISTS (
   SELECT 1
     FROM survey_groups sg
     JOIN surveys s ON s.id = sg.survey_id
    WHERE sg.group_id = g.id AND s.require_guild
 );

-- The narrowing lists are unioned into the group, per group. Only gated surveys
-- contribute: an ungated survey's leftover lists were never evaluated, so
-- carrying them across would invent a restriction rather than preserve one.
--
-- An empty list on a gated survey contributes nothing, because empty means "any
-- member of the server" - so a group holding one survey narrowed to a role and
-- another narrowed to nothing ends up requiring that role. That is narrower
-- than the second survey was and wider than nothing at all, which is the safe
-- direction: a restriction may widen within a group, never disappear.
UPDATE groups g
   SET gate_role_ids = u.role_ids
  FROM (
    SELECT sg.group_id, array_agg(DISTINCT role_id) AS role_ids
      FROM survey_groups sg
      JOIN surveys s ON s.id = sg.survey_id
      CROSS JOIN LATERAL unnest(s.gate_role_ids) AS role_id
     WHERE s.require_guild
     GROUP BY sg.group_id
  ) u
 WHERE u.group_id = g.id;

UPDATE groups g
   SET gate_channel_ids = u.channel_ids
  FROM (
    SELECT sg.group_id, array_agg(DISTINCT channel_id) AS channel_ids
      FROM survey_groups sg
      JOIN surveys s ON s.id = sg.survey_id
      CROSS JOIN LATERAL unnest(s.gate_channel_ids) AS channel_id
     WHERE s.require_guild
     GROUP BY sg.group_id
  ) u
 WHERE u.group_id = g.id;

-- The survey's own copy goes only once every group has been given its own.
ALTER TABLE surveys DROP COLUMN require_guild;
ALTER TABLE surveys DROP COLUMN gate_role_ids;
ALTER TABLE surveys DROP COLUMN gate_channel_ids;

-- Ownership now lives in survey_groups. The column's index goes with it.
ALTER TABLE surveys DROP COLUMN group_id;

-- ---------------------------------------------------------------------------
-- The default group concept goes away
-- ---------------------------------------------------------------------------
--
-- Only the FLAG is dropped. Every group row survives, including the one that
-- carried it. Dropping the column takes groups_single_default_idx with it,
-- since a partial index cannot outlive the column it is predicated on.
--
-- The consequence is deliberate: an administrator who belongs to no group now
-- resolves to no access at all, rather than quietly inheriting the default
-- group's permissions. Creating an admin therefore requires a group, and
-- Discord role- and channel-derived admins land in the group named by
-- discord_admin_group_id below.

ALTER TABLE groups DROP COLUMN is_default;

-- ---------------------------------------------------------------------------
-- A super administrator is never a member of a group
-- ---------------------------------------------------------------------------
--
-- They bypass groups entirely, so a membership grants them nothing and only
-- implies their access comes from that group. The API refuses to create one
-- from here on; this clears the ones already stored. On this deployment that is
-- exactly one row - acid_rain in Public - which is inert today and misleading
-- once the default fallback is gone.

DELETE FROM group_members m
 USING users u
 WHERE u.id = m.user_id AND u.tier = 'super_admin';

-- ---------------------------------------------------------------------------
-- Where Discord role- and channel-derived admins land
-- ---------------------------------------------------------------------------
--
-- Nobody creates these accounts and nobody picks a group for them: the tier
-- comes from holding a role or seeing a channel, resolved per request. With the
-- default fallback gone they would have no access at all, so the Discord plugin
-- names the group they resolve against. Left unset they get nothing, which is
-- the safe reading of "no group has been chosen for them" and is stated on the
-- plugin's settings page beside the roles and channels themselves.

ALTER TABLE app_settings
    ADD COLUMN discord_admin_group_id uuid REFERENCES groups(id) ON DELETE SET NULL;
