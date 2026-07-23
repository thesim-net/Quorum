-- Plugin framework: a global on/off per plugin, per-survey plugin settings,
-- and the bookkeeping the Discord-posting plugins need to avoid duplicates.

-- Global enablement, e.g. { "announcements": true, "quotas": true, ... }.
ALTER TABLE app_settings ADD COLUMN plugins jsonb NOT NULL DEFAULT '{}'::jsonb;

-- Per-survey plugin configuration, e.g.
--   { "announceChannelId": "123", "quota": { "maxResponses": 100 } }
ALTER TABLE surveys ADD COLUMN plugin_config jsonb NOT NULL DEFAULT '{}'::jsonb;

-- One-shot flags so an announcement or reminder is posted at most once.
ALTER TABLE surveys ADD COLUMN announce_open_sent  boolean NOT NULL DEFAULT false;
ALTER TABLE surveys ADD COLUMN announce_close_sent boolean NOT NULL DEFAULT false;
ALTER TABLE surveys ADD COLUMN reminder_sent       boolean NOT NULL DEFAULT false;

-- Conditional-logic question visibility lives in questions.config.showIf, which
-- needs no schema change since config is already jsonb.
