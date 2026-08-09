-- Per-user permissions are retired. An admin account is now two facts: whether
-- it is a super admin, and which groups it belongs to.
--
-- The column has been inert since 010 made permissions survey-scoped. What an
-- admin may do to a survey is resolved against the group that owns it, and an
-- admin in no group resolves against the default group, which 010 seeds and
-- which cannot be deleted. Nothing reads this column any more: the last code
-- path that did - the "no groups exist at all" fallback in lib/groups.js, and
-- the global `can()` guard on the Discord guild listing - went with this
-- change, so dropping it removes a list that looked like it granted access and
-- did not.
--
-- Group membership is not affected: 010 already moved every plain admin with
-- permissions into the default group, so nobody loses access here.

ALTER TABLE users DROP COLUMN permissions;
