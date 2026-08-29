-- Automatic updates: fetching a new version, and restarting into it.
--
-- Two switches rather than one. Pulling is background work nobody notices;
-- restarting drops every in-flight response and runs migrations. Both default
-- off, so no existing deployment acquires either by applying this migration.

ALTER TABLE app_settings
    ADD COLUMN auto_update_enabled boolean NOT NULL DEFAULT false,

    -- Nullable: a disabled schedule keeps no interval, so re-enabling cannot
    -- silently resume an old cadence. The twice-a-day floor is enforced in
    -- lib/autoUpdate.js, where a refusal can be a sentence rather than a
    -- constraint violation.
    ADD COLUMN auto_update_interval_seconds integer,

    ADD COLUMN auto_update_restart boolean NOT NULL DEFAULT false,

    -- NULL means never run, which reads as due immediately.
    ADD COLUMN auto_update_last_run_at timestamptz,

    -- Downloaded but not yet running. Cleared by the new version on boot.
    ADD COLUMN auto_update_staged_version text,

    -- So a deployment that cannot reach the registry says so, rather than
    -- appearing to work while doing nothing.
    ADD COLUMN auto_update_last_error text;
