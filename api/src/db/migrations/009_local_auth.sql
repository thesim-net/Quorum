-- Local username/password accounts, per-method sign-in toggles, and TOTP
-- enrolment storage. Discord identity becomes optional: a user is now a Discord
-- account, a local account, or both, and survey respondents need no account at
-- all.

ALTER TABLE users ALTER COLUMN discord_id DROP NOT NULL;
ALTER TABLE users ALTER COLUMN username DROP NOT NULL;

ALTER TABLE users ADD COLUMN password_hash text;
ALTER TABLE users ADD COLUMN totp_secret_enc bytea;
ALTER TABLE users ADD COLUMN totp_required boolean NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN totp_confirmed_at timestamptz;

-- Every account still needs at least one identity to sign in with.
ALTER TABLE users ADD CONSTRAINT users_identity_present
    CHECK (discord_id IS NOT NULL OR username IS NOT NULL);

-- Local sign-in names must be unique. Scoped to accounts that actually hold a
-- password: usernames mirrored from Discord predate this migration and were
-- never guaranteed unique, so a full UNIQUE constraint could fail to apply on
-- an existing deployment.
CREATE UNIQUE INDEX users_local_username_key
    ON users (lower(username)) WHERE password_hash IS NOT NULL;

-- Which sign-in methods are offered, e.g. { "local": true, "discord": true }.
ALTER TABLE app_settings
    ADD COLUMN auth_methods jsonb NOT NULL DEFAULT '{"local": true}'::jsonb;

-- Deployments already connected to Discord keep their sign-in across the
-- upgrade: the discord plugin is switched on for them and the Discord method
-- stays enabled alongside the new local one.
UPDATE app_settings
   SET auth_methods = '{"local": true, "discord": true}'::jsonb,
       plugins = plugins || '{"discord": true}'::jsonb
 WHERE discord_client_id IS NOT NULL;
