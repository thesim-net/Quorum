-- Quorum initial schema.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TYPE survey_status   AS ENUM ('draft', 'open', 'closed');
CREATE TYPE survey_gate     AS ENUM ('guild', 'roles', 'channel');
CREATE TYPE response_status AS ENUM ('in_progress', 'completed');
CREATE TYPE question_type   AS ENUM (
    'short_text',
    'long_text',
    'integer',
    'single_choice',
    'multi_choice',
    'ranking',
    'boolean',
    'scale'
);

-- ---------------------------------------------------------------------------
-- Identity
-- ---------------------------------------------------------------------------

CREATE TABLE users (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    discord_id    text NOT NULL UNIQUE,
    username      text NOT NULL,
    display_name  text,
    avatar        text,
    is_admin      boolean NOT NULL DEFAULT false,
    created_at    timestamptz NOT NULL DEFAULT now(),
    last_login_at timestamptz
);

CREATE TABLE sessions (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    -- Roles are snapshotted at login so survey gates do not hit Discord on
    -- every request; refreshed whenever the snapshot ages past the TTL.
    role_ids       text[] NOT NULL DEFAULT '{}',
    roles_synced_at timestamptz NOT NULL DEFAULT now(),
    user_agent_hash bytea,
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL
);

CREATE INDEX sessions_user_id_idx    ON sessions(user_id);
CREATE INDEX sessions_expires_at_idx ON sessions(expires_at);

-- ---------------------------------------------------------------------------
-- Surveys
-- ---------------------------------------------------------------------------

CREATE TABLE surveys (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    slug        text NOT NULL UNIQUE,
    title       text NOT NULL,
    description text NOT NULL DEFAULT '',
    status      survey_status NOT NULL DEFAULT 'draft',

    opens_at  timestamptz,
    closes_at timestamptz,

    -- Participant-facing behaviour.
    allow_response_edits boolean NOT NULL DEFAULT false,
    show_progress        boolean NOT NULL DEFAULT true,

    -- Collection toggles. Each one is disclosed on the survey intro screen
    -- before the participant answers anything.
    collect_timing   boolean NOT NULL DEFAULT false,
    collect_location boolean NOT NULL DEFAULT false,
    collect_identity boolean NOT NULL DEFAULT false,

    -- Access gate.
    gate            survey_gate NOT NULL DEFAULT 'guild',
    gate_role_ids   text[] NOT NULL DEFAULT '{}',
    gate_channel_id text,

    -- Per-survey HMAC key. Rotating or deleting it permanently severs every
    -- response from its respondent, which is what makes deletion meaningful.
    respondent_key bytea NOT NULL DEFAULT gen_random_bytes(32),

    created_by uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    opened_at  timestamptz,
    closed_at  timestamptz,

    CONSTRAINT surveys_gate_roles_present
        CHECK (gate <> 'roles' OR array_length(gate_role_ids, 1) > 0),
    CONSTRAINT surveys_gate_channel_present
        CHECK (gate <> 'channel' OR gate_channel_id IS NOT NULL),
    CONSTRAINT surveys_window_ordered
        CHECK (opens_at IS NULL OR closes_at IS NULL OR opens_at < closes_at)
);

CREATE INDEX surveys_status_idx ON surveys(status);

CREATE TABLE questions (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    survey_id  uuid NOT NULL REFERENCES surveys(id) ON DELETE CASCADE,
    position   integer NOT NULL,
    type       question_type NOT NULL,
    prompt     text NOT NULL,
    help_text  text NOT NULL DEFAULT '',
    required   boolean NOT NULL DEFAULT true,
    -- Type-specific settings; shape is enforced in the API layer.
    --   short_text/long_text : { minLength, maxLength }
    --   integer              : { min, max, step }
    --   single/multi_choice  : { allowOther, otherMaxLength, randomize,
    --                            minSelections, maxSelections }
    --   ranking              : { randomize }
    --   boolean              : { trueLabel, falseLabel }
    --   scale                : { min, max, minLabel, maxLabel }
    config     jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),

    UNIQUE (survey_id, position) DEFERRABLE INITIALLY DEFERRED
);

CREATE INDEX questions_survey_id_idx ON questions(survey_id, position);

CREATE TABLE question_options (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    question_id uuid NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
    position    integer NOT NULL,
    label       text NOT NULL,

    UNIQUE (question_id, position) DEFERRABLE INITIALLY DEFERRED
);

CREATE INDEX question_options_question_id_idx ON question_options(question_id, position);

-- ---------------------------------------------------------------------------
-- Responses
-- ---------------------------------------------------------------------------

CREATE TABLE responses (
    id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    survey_id uuid NOT NULL REFERENCES surveys(id) ON DELETE CASCADE,

    -- HMAC(survey.respondent_key, pepper || discord_id). Always present: it is
    -- what enforces one-response-per-member and lets a participant find their
    -- own submission to edit. It is never exposed by any API route.
    respondent_hash bytea NOT NULL,

    -- Populated only when the survey has collect_identity enabled. When the
    -- toggle is off this stays NULL and no route can recover who responded.
    user_id uuid REFERENCES users(id) ON DELETE SET NULL,

    status       response_status NOT NULL DEFAULT 'in_progress',
    started_at   timestamptz NOT NULL DEFAULT now(),
    completed_at timestamptz,
    updated_at   timestamptz NOT NULL DEFAULT now(),

    -- Populated only when collect_timing is enabled.
    duration_ms integer CHECK (duration_ms IS NULL OR duration_ms >= 0),

    -- Populated only when collect_location is enabled. Country granularity
    -- only; the source IP is resolved in-process and never persisted.
    country_code char(2),

    UNIQUE (survey_id, respondent_hash),

    CONSTRAINT responses_completed_has_timestamp
        CHECK ((status = 'completed') = (completed_at IS NOT NULL))
);

CREATE INDEX responses_survey_status_idx ON responses(survey_id, status);
CREATE INDEX responses_user_id_idx       ON responses(user_id) WHERE user_id IS NOT NULL;

CREATE TABLE answers (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    response_id uuid NOT NULL REFERENCES responses(id) ON DELETE CASCADE,
    question_id uuid NOT NULL REFERENCES questions(id) ON DELETE CASCADE,

    -- Normalised per type:
    --   short_text/long_text : { "text": "..." }
    --   integer/scale        : { "number": 7 }
    --   boolean              : { "bool": true }
    --   single_choice        : { "optionId": "...", "other": "..."|null }
    --   multi_choice         : { "optionIds": [...], "other": "..."|null }
    --   ranking              : { "order": ["optionId", ...] }
    --   skipped optional     : { "skipped": true }
    value jsonb NOT NULL,

    -- Populated only when collect_timing is enabled.
    time_ms integer CHECK (time_ms IS NULL OR time_ms >= 0),

    updated_at timestamptz NOT NULL DEFAULT now(),

    UNIQUE (response_id, question_id)
);

CREATE INDEX answers_question_id_idx ON answers(question_id);

-- ---------------------------------------------------------------------------
-- Admin audit trail
-- ---------------------------------------------------------------------------

CREATE TABLE audit_log (
    id          bigserial PRIMARY KEY,
    actor_id    uuid REFERENCES users(id) ON DELETE SET NULL,
    action      text NOT NULL,
    target_type text,
    target_id   text,
    meta        jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX audit_log_created_at_idx ON audit_log(created_at DESC);
