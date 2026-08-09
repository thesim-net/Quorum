-- Deployment-wide two-factor policy. When on, every account that can reach the
-- admin panel is treated as 2FA-required regardless of its per-account
-- totp_required flag, so a single switch enforces it for all administrators.
-- Off by default, preserving current behaviour where the requirement is set per
-- account. Like the per-account flag, it only bites while the twofactor plugin
-- is enabled.
ALTER TABLE app_settings
    ADD COLUMN require_2fa_all_admins boolean NOT NULL DEFAULT false;
