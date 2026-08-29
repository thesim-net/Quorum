-- Record the Discord identity behind a response on the response itself.
--
-- `collect_identity` has been, until now, a promise the write path could not
-- keep. Identity was recovered by joining `responses.user_id` to `users`, and
-- that column was only ever populated when `req.user` was set - which means an
-- admin session. A respondent taking a gated survey is emphatically not an
-- account: the OAuth callback issues the signed `quorum_guild` cookie and
-- creates no `users` row, no tier and no session, by design. So `req.user` was
-- null for every genuine participant, `user_id` stayed NULL, and the export
-- reported an empty username for a survey that had declared it was collecting
-- one.
--
-- The fix keeps that design rather than working around it. A respondent still
-- gets no `users` row; the identity is stored beside the response, which is the
-- only place that actually knows it. `user_id` stays exactly as it was, for the
-- case it always described - a signed-in admin answering their own survey - and
-- the reporting queries read whichever of the two is present.
--
-- Written only when the survey both collects identity AND is gated on the
-- guild. An ungated survey hashes a random browser cookie and never learns who
-- is behind it, so there is nothing truthful to record; leaving these NULL is
-- what keeps "truly anonymous" true.

ALTER TABLE responses
    -- The raw Discord id, so an admin can act on a response - look the member
    -- up, message them - rather than only read a name that may since have
    -- changed. Deliberately not a foreign key: it names a Discord account, not
    -- a Quorum one, and there is no row for it to reference.
    ADD COLUMN respondent_discord_id    text,

    -- The account's handle at the moment they answered, and their server
    -- nickname (falling back to their global display name). Snapshotted rather
    -- than resolved later on purpose: a nickname changes, and the reviewer
    -- needs to know who applied, not who that id is called today.
    ADD COLUMN respondent_username      text,
    ADD COLUMN respondent_display_name  text;

-- "Who answered this survey" is asked once per results page, over one survey's
-- rows, so the existing survey_id index already carries it. No index here.

-- Anonymising a survey rotates its respondent key and clears the recorded
-- authors. That flow already NULLed `user_id`; these columns join it, in the
-- API, for the same reason - leaving them would defeat the point of the button.
