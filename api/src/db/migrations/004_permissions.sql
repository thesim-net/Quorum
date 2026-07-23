-- Granular admin permissions, and gates that combine roles with channels.

-- ---------------------------------------------------------------------------
-- Permissions
-- ---------------------------------------------------------------------------
--
-- `is_admin` now means "full administrator": every permission, plus managing
-- other admins and re-running setup. `permissions` scopes a limited admin, who
-- reaches the panel but only the parts they were granted.

ALTER TABLE users ADD COLUMN permissions text[] NOT NULL DEFAULT '{}';

-- Existing admins keep everything they had. Without this they would reach the
-- panel on the next deploy with no permissions at all.
UPDATE users
   SET permissions = ARRAY['surveys.write', 'surveys.publish', 'surveys.delete', 'results.read']
 WHERE is_admin = true;

-- ---------------------------------------------------------------------------
-- Gates
-- ---------------------------------------------------------------------------
--
-- The single-mode enum is replaced by two independent lists. An empty list is
-- no requirement; when both are populated a member must satisfy BOTH, which is
-- narrower than either alone.

ALTER TABLE surveys ADD COLUMN gate_channel_ids text[] NOT NULL DEFAULT '{}';

-- Carry the old single-mode configuration across, discarding the list that the
-- previous mode was ignoring.
UPDATE surveys
   SET gate_channel_ids = ARRAY[gate_channel_id]
 WHERE gate = 'channel' AND gate_channel_id IS NOT NULL;

UPDATE surveys SET gate_role_ids = '{}' WHERE gate <> 'roles';

ALTER TABLE surveys DROP CONSTRAINT IF EXISTS surveys_gate_roles_present;
ALTER TABLE surveys DROP CONSTRAINT IF EXISTS surveys_gate_channel_present;
ALTER TABLE surveys DROP COLUMN gate_channel_id;
ALTER TABLE surveys DROP COLUMN gate;

DROP TYPE IF EXISTS survey_gate;
