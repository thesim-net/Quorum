-- Per-survey Discord guild gating, and per-survey response limits.

-- ---------------------------------------------------------------------------
-- Guild gate
-- ---------------------------------------------------------------------------
--
-- Until now "restricted" was an accident of two list columns: a survey was
-- gated if it happened to name a role or a channel, and open otherwise. The
-- decision is explicit from here on. `require_guild` says the respondent must
-- sign in with Discord and be a member of the connected server; the two lists
-- stay, demoted to narrowing who FROM that server may take it. With the flag
-- off a survey is truly anonymous - no sign-in, no Discord call - and the lists
-- are never evaluated.

ALTER TABLE surveys ADD COLUMN require_guild boolean NOT NULL DEFAULT false;

-- Anything that named a role or a channel was already gated, so it stays
-- gated. Without this every previously restricted survey would quietly open to
-- anyone with the link on the next deploy. array_length returns NULL for an
-- empty array, and NULL > 0 is not true, so an unrestricted survey is left
-- alone.
UPDATE surveys
   SET require_guild = true
 WHERE array_length(gate_role_ids, 1) > 0
    OR array_length(gate_channel_ids, 1) > 0;

-- ---------------------------------------------------------------------------
-- One response per person
-- ---------------------------------------------------------------------------
--
-- One response per respondent was the only behaviour there was, hardcoded into
-- the UNIQUE constraint below. It becomes the survey author's choice, defaulting
-- to on so every existing survey keeps behaving exactly as it does today.

ALTER TABLE surveys ADD COLUMN one_response_per_person boolean NOT NULL DEFAULT true;

-- The guarantee stays in the database rather than moving into application code,
-- because it is the only place two simultaneous submissions can be adjudicated
-- without a lock. A partial unique index cannot read the survey's flag, so each
-- response carries a copy of it: rows of a one-per-person survey are `exclusive`
-- and collide with each other, rows of a survey that allows repeats are not
-- indexed at all. The API keeps the copy in step whenever the flag is changed.
ALTER TABLE responses ADD COLUMN exclusive boolean NOT NULL DEFAULT true;

ALTER TABLE responses DROP CONSTRAINT IF EXISTS responses_survey_id_respondent_hash_key;

CREATE UNIQUE INDEX responses_one_per_respondent_idx
    ON responses (survey_id, respondent_hash) WHERE exclusive;
