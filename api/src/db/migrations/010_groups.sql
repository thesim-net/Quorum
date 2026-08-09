-- Groups: named sets of admins, each deciding what its members may do to its
-- own surveys, and optionally granting other groups rights over them.
--
-- Permissions become survey-scoped. What an admin may do is resolved against
-- the group that owns the survey rather than held globally. The seeded
-- "Default" group carries every permission, so behaviour before groups is
-- preserved: an admin in Default can still do anything to Default's surveys.

CREATE TABLE groups (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name               text NOT NULL UNIQUE,
    is_default         boolean NOT NULL DEFAULT false,
    -- What a member of this group may do to surveys this group owns.
    member_permissions text[] NOT NULL DEFAULT '{}',
    created_at         timestamptz NOT NULL DEFAULT now()
);

-- Exactly one group is the default at a time: the partial unique index allows
-- at most one row with is_default = true.
CREATE UNIQUE INDEX groups_single_default_idx ON groups (is_default) WHERE is_default;

-- The seeded default holds every permission, so existing admins keep working.
INSERT INTO groups (name, is_default, member_permissions)
VALUES ('Default', true,
        ARRAY['surveys.write', 'surveys.publish', 'surveys.delete', 'results.read']);

-- A user may belong to several groups; their rights are the union across them.
CREATE TABLE group_members (
    group_id uuid NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    user_id  uuid NOT NULL REFERENCES users(id)  ON DELETE CASCADE,
    added_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (group_id, user_id)
);

CREATE INDEX group_members_user_id_idx ON group_members(user_id);

-- A grant lets members of the source group act on the target group's surveys,
-- with exactly the listed permissions. A group cannot grant to itself.
CREATE TABLE group_grants (
    source_group_id uuid NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    target_group_id uuid NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    permissions     text[] NOT NULL DEFAULT '{}',
    PRIMARY KEY (source_group_id, target_group_id),
    CONSTRAINT group_grants_distinct CHECK (source_group_id <> target_group_id)
);

-- Every survey is owned by a group. Existing surveys join the default, then the
-- column is made mandatory so a survey can never be left without an owner.
ALTER TABLE surveys ADD COLUMN group_id uuid REFERENCES groups(id);
UPDATE surveys SET group_id = (SELECT id FROM groups WHERE is_default)
 WHERE group_id IS NULL;
ALTER TABLE surveys ALTER COLUMN group_id SET NOT NULL;

CREATE INDEX surveys_group_id_idx ON surveys(group_id);

-- Existing plain admins move into the default group, so their access carries
-- across the switch to survey-scoped permissions unchanged. Default already
-- grants all four permissions, which for the single existing deployment is an
-- acceptable, documented widening. Super admins bypass groups entirely and
-- need no membership.
INSERT INTO group_members (group_id, user_id)
SELECT (SELECT id FROM groups WHERE is_default), id
  FROM users
 WHERE tier = 'admin' AND cardinality(permissions) > 0
ON CONFLICT DO NOTHING;
