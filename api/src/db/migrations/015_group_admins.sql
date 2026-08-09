-- Group administrators: a membership that administers its own group.
--
-- Deliberately a property of the MEMBERSHIP rather than of the account. Someone
-- administers the group they were placed in, never every group they happen to
-- belong to: an administrator of Selections who is later added to Astro as an
-- ordinary member administers Selections and nothing else. Every check reads
-- "does this person hold an is_admin membership of THIS group", so there is no
-- such thing as being a group administrator in general.
--
-- Holding it on more than one group is possible, and is a super administrator's
-- decision to make; a group administrator can only ever set it inside the one
-- group they already administer.
--
-- Super administrators bypass groups entirely, so the two standings are
-- exclusive: the API refuses to set this on a super admin's membership, and
-- refuses to promote an account to super admin while it still holds one.
--
-- No backfill. Nobody administered a group before this migration, so the
-- default is the whole of it: existing memberships stay ordinary memberships.

ALTER TABLE group_members ADD COLUMN is_admin boolean NOT NULL DEFAULT false;

-- "Which groups does this person administer" is asked on every membership
-- change they attempt, and the answer is a small, selective set.
CREATE INDEX group_members_admin_idx ON group_members (user_id) WHERE is_admin;
