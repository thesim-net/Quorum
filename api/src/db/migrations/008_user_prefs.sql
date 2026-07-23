-- Per-user interface preferences, so a chosen skin follows the account across
-- browsers and devices rather than living only in one browser's storage.
ALTER TABLE users ADD COLUMN prefs jsonb NOT NULL DEFAULT '{}'::jsonb;
