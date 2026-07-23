-- Runtime configuration, so a deployment does not carry Discord credentials in
-- its environment. Secrets are stored encrypted; see lib/secretbox.js.

CREATE TABLE app_settings (
    -- Single-row table: the CHECK pins the primary key to one value.
    id boolean PRIMARY KEY DEFAULT true CHECK (id),

    discord_client_id         text,
    discord_client_secret_enc bytea,
    discord_bot_token_enc     bytea,
    discord_guild_id          text,

    -- Cached for display, refreshed whenever setup runs.
    guild_name text,

    -- Discord roles that grant admin access, on top of users.is_admin.
    admin_role_ids text[] NOT NULL DEFAULT '{}',

    configured_at timestamptz,
    configured_by uuid REFERENCES users(id) ON DELETE SET NULL,
    updated_at    timestamptz NOT NULL DEFAULT now()
);

-- One-time tokens that authorise the setup wizard before any admin exists.
CREATE TABLE setup_tokens (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    token_hash  bytea NOT NULL UNIQUE,
    created_at  timestamptz NOT NULL DEFAULT now(),
    expires_at  timestamptz NOT NULL,
    consumed_at timestamptz,
    -- Set once credentials are saved: the next Discord login carrying this
    -- setup session is granted admin, which is how the first admin is minted.
    awaiting_admin_claim boolean NOT NULL DEFAULT false
);

CREATE INDEX setup_tokens_expires_at_idx ON setup_tokens(expires_at);
