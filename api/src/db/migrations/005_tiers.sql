-- Two admin tiers, plus admin access granted by channel as well as role.
--
--   super_admin  unrestricted: every permission, managing other admins, and
--                re-running setup. Can promote further super admins. Not
--                visible to plain admins.
--   admin        only the permissions explicitly granted.
--
-- The first super admin is whoever completes setup and signs in; from then on
-- super admins create each other.

CREATE TYPE admin_tier AS ENUM ('none', 'admin', 'super_admin');

ALTER TABLE users ADD COLUMN tier admin_tier NOT NULL DEFAULT 'none';

-- Existing full admins were unrestricted, so they become super admins.
UPDATE users SET tier = 'super_admin' WHERE is_admin = true;

-- Existing limited admins keep exactly the grants they had.
UPDATE users SET tier = 'admin' WHERE is_admin = false AND cardinality(permissions) > 0;

ALTER TABLE users DROP COLUMN is_admin;

CREATE INDEX users_tier_idx ON users(tier) WHERE tier <> 'none';

-- Admin access can now be granted by channel visibility as well as by role.
-- Both grant the `admin` tier, never `super_admin`: an unrestricted account
-- should never appear because someone was added to a channel.
ALTER TABLE app_settings ADD COLUMN admin_channel_ids text[] NOT NULL DEFAULT '{}';
