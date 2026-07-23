-- Server-authoritative question timing.
--
-- The client reports only *which* question it moved to; every timestamp comes
-- from the database clock, so a participant cannot forge how long they spent.
--
-- Rows here are working state, not a retained record. On submit they are
-- collapsed into answers.time_ms / responses.duration_ms and deleted, so no
-- per-participant timeline outlives the response itself.

CREATE TYPE response_event_kind AS ENUM ('enter', 'heartbeat', 'submit');

CREATE TABLE response_events (
    id          bigserial PRIMARY KEY,
    response_id uuid NOT NULL REFERENCES responses(id) ON DELETE CASCADE,
    -- NULL for events that are not tied to a question (intro screen, submit).
    question_id uuid REFERENCES questions(id) ON DELETE CASCADE,
    kind        response_event_kind NOT NULL,
    at          timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX response_events_response_idx ON response_events(response_id, at);
