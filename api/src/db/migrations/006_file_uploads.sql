-- File-attachment question type.

-- Adding an enum value cannot be used in the same transaction it is created in,
-- but this migration only registers it, so the wrapping transaction is fine.
ALTER TYPE question_type ADD VALUE IF NOT EXISTS 'file_upload';

-- One uploaded file per file-upload answer. The bytes live on disk under
-- storage_key; this table is the index and the original filename.
CREATE TABLE answer_files (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    response_id uuid NOT NULL REFERENCES responses(id) ON DELETE CASCADE,
    question_id uuid NOT NULL REFERENCES questions(id) ON DELETE CASCADE,

    -- Random on-disk name, never the participant's filename.
    storage_key   text NOT NULL UNIQUE,
    original_name text NOT NULL,
    mime          text NOT NULL,
    size_bytes    integer NOT NULL CHECK (size_bytes >= 0),

    created_at timestamptz NOT NULL DEFAULT now(),

    -- One file per answer; re-uploading replaces it.
    UNIQUE (response_id, question_id)
);

CREATE INDEX answer_files_question_idx ON answer_files(question_id);
