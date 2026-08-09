-- Global default for the animated QUORUM wordmark, an accessibility control
-- (photosensitivity/epilepsy). On by default, so nothing changes visually for
-- an existing deployment; a super admin can turn it off deployment-wide, and a
-- signed-in user's own preference (users.prefs.asciiAnimation) overrides it.
ALTER TABLE app_settings
    ADD COLUMN ascii_animation_default boolean NOT NULL DEFAULT true;
