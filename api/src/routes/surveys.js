import { Router } from 'express';
import multer from 'multer';
import { query, transaction } from '../db/pool.js';
import { AnswerError, normaliseAnswer } from '../lib/answers.js';
import { visibleQuestions } from '../lib/conditional.js';
import { PLUGINS, isPluginEnabled } from '../lib/plugins.js';
import { current } from '../lib/settings.js';
import { countryOf } from '../lib/geo.js';
import { respondentHash, respondentIdentity } from '../lib/respondent.js';
import {
  START,
  allowsRepeat,
  currentAttempt,
  oneResponsePerPerson,
  startAction,
} from '../lib/responsePolicy.js';
import { collapseEvents, totalDuration } from '../lib/timing.js';
import {
  HARD_MAX_BYTES,
  UploadError,
  deleteFile,
  mimeForName,
  storeFile,
  validateUpload,
} from '../lib/uploads.js';
import { ensureRespondent } from '../middleware/respondent.js';
import { cachedGuildName, channelVisibleTo, guildMembership } from '../plugins/discord/gate.js';
import {
  ACCESS,
  everyGroupRequiresGuild,
  refusal,
  resolveGroupAccess,
} from '../plugins/discord/guildGate.js';

export const surveyRouter = Router();

// Taking a survey needs no account: every caller gets an anonymous respondent
// id, and only Discord-gated surveys ask for more.
surveyRouter.use(ensureRespondent());

// Files are held in memory just long enough to validate and write them. The
// ceiling here is the absolute maximum; each question enforces its own,
// smaller, limit once the file is in hand.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: HARD_MAX_BYTES, files: 1 },
});

/**
 * Whether a survey is currently accepting responses.
 *
 * The scheduled window is honoured alongside the status flag, so a survey can
 * be set to open ahead of time and close itself.
 *
 * @param {object} survey Survey row.
 * @returns {boolean} True when participants may submit.
 */
function isAcceptingResponses(survey) {
  if (survey.status !== 'open') return false;

  const now = Date.now();
  if (survey.opens_at && now < new Date(survey.opens_at).getTime()) return false;
  if (survey.closes_at && now > new Date(survey.closes_at).getTime()) return false;
  return true;
}

/**
 * The collection toggles a participant is shown before starting.
 *
 * @param {object} survey Survey row.
 * @returns {{timing: boolean, location: boolean, identity: boolean}} Disclosures.
 */
const disclosures = (survey) => ({
  timing: survey.collect_timing,
  location: survey.collect_location,
  identity: survey.collect_identity,
});

/**
 * The Discord identity behind this request, if there is one.
 *
 * A respondent proves one through the survey sign-in; an admin already carries
 * theirs in the session, so a gated survey never sends them back round a trip
 * they have effectively already made.
 *
 * @param {import('express').Request} req
 * @returns {string|null} A Discord user id, or null.
 */
const discordIdOf = (req) => req.user?.discordId ?? req.respondentDiscordId ?? null;

/** The connected server's name for participant copy, at no cost to the request. */
const guildName = () => current().discord.guildName ?? cachedGuildName();

/**
 * The audience rules of every group a survey belongs to.
 *
 * @param {string} surveyId
 * @returns {Promise<Array<{require_guild: boolean, gate_role_ids: string[],
 *   gate_channel_ids: string[]}>>} One entry per group.
 */
async function audiencesFor(surveyId) {
  const { rows } = await query(
    `SELECT g.require_guild, g.gate_role_ids, g.gate_channel_ids
       FROM survey_groups sg JOIN groups g ON g.id = sg.group_id
      WHERE sg.survey_id = $1`,
    [surveyId],
  );
  return rows;
}

/**
 * Decides whether the caller may open a survey.
 *
 * The policy itself is in `guildGate.js`; this supplies the Discord lookups it
 * runs on. A survey with an open group never reaches them - that is what "truly
 * anonymous" means here, and it is why a Discord outage cannot touch one.
 *
 * @param {Array<object>} audiences The survey's groups' audience rules.
 * @param {import('express').Request} req The request, for its identities.
 * @returns {Promise<{allowed: boolean, status?: number, code?: string,
 *   reason?: string, guild?: string|null}>} Verdict, with a participant-safe
 *   reason when refused.
 */
async function surveyAccess(audiences, req) {
  const settings = current();

  const outcome = await resolveGroupAccess(
    {
      audiences,
      pluginReady:
        isPluginEnabled(settings.plugins, PLUGINS.DISCORD) && settings.discord.configured,
      discordId: discordIdOf(req),
    },
    { member: guildMembership, canSeeChannel: channelVisibleTo },
  );

  if (outcome === ACCESS.OPEN) return { allowed: true };
  return { allowed: false, ...refusal(outcome, guildName()) };
}

/**
 * Attaches a survey's effective gating to the row.
 *
 * `require_guild` is no longer a column: it is true only when every group the
 * survey belongs to requires the guild, because a single open group leaves an
 * anonymous way in. Everything downstream that asks "does this survey know who
 * is answering" - the respondent key above all - reads it from here.
 *
 * @param {object} survey Survey row.
 * @param {Array<object>} audiences The survey's groups' audience rules.
 * @returns {object} The row, with `require_guild` derived from its groups.
 */
const withGating = (survey, audiences) => ({
  ...survey,
  require_guild: everyGroupRequiresGuild(audiences),
});

/**
 * Loads a survey by slug and confirms the caller may see it.
 *
 * @param {string} slug Survey slug.
 * @param {import('express').Request} req The request, for its identities.
 * @returns {Promise<{survey: object}|{error: string, status: number, code?: string}>}
 *   The survey, or a refusal with the status to send.
 */
async function loadAccessibleSurvey(slug, req) {
  const { rows } = await query('SELECT * FROM surveys WHERE slug = $1', [slug]);
  if (rows.length === 0) return { error: 'Survey not found.', status: 404 };

  if (rows[0].status === 'draft') return { error: 'Survey not found.', status: 404 };

  const audiences = await audiencesFor(rows[0].id);
  const access = await surveyAccess(audiences, req);
  if (!access.allowed) {
    return { error: access.reason, status: access.status, code: access.code, guild: access.guild };
  }

  return { survey: withGating(rows[0], audiences) };
}

/**
 * Which id this survey counts the caller by.
 *
 * A gated survey counts Discord accounts, an anonymous one counts browsers.
 * Resolved per survey rather than per request, because one browser can hold
 * both at once.
 *
 * @param {object} survey Survey row.
 * @param {import('express').Request} req
 * @returns {string|null} The opaque id to hash, or null when a gated survey has
 *   no verified Discord identity behind it.
 */
const identityFor = (survey, req) =>
  respondentIdentity(survey, { cookieId: req.respondentId, discordId: discordIdOf(req) });

/**
 * Finds the response the caller is currently working on, if any.
 *
 * A survey that allows repeats can hold several under one respondent hash, so
 * every row is read and `currentAttempt` picks between them rather than the
 * query trusting that there is only ever one.
 *
 * @param {object} survey Survey row, for its respondent key.
 * @param {string|null} respondentId The caller's opaque respondent id.
 * @returns {Promise<object|null>} Response row, or null.
 */
async function findOwnResponse(survey, respondentId) {
  if (!respondentId) return null;

  const hash = respondentHash(survey.respondent_key, respondentId);
  const { rows } = await query(
    'SELECT * FROM responses WHERE survey_id = $1 AND respondent_hash = $2',
    [survey.id, hash],
  );
  return currentAttempt(rows);
}

/** Lists every open survey the caller can access. */
surveyRouter.get('/', async (req, res, next) => {
  try {
    const { rows } = await query(
      // Each survey carries its groups' audience rules with it: the gate is
      // evaluated per survey, and one query beats one per row.
      `SELECT s.*,
              COALESCE(
                jsonb_agg(
                  jsonb_build_object(
                    'require_guild', g.require_guild,
                    'gate_role_ids', g.gate_role_ids,
                    'gate_channel_ids', g.gate_channel_ids
                  )
                ) FILTER (WHERE g.id IS NOT NULL),
                '[]'::jsonb
              ) AS audiences
         FROM surveys s
         LEFT JOIN survey_groups sg ON sg.survey_id = s.id
         LEFT JOIN groups g ON g.id = sg.group_id
        WHERE s.status = 'open'
          AND (s.opens_at IS NULL OR s.opens_at <= now())
          AND (s.closes_at IS NULL OR s.closes_at > now())
        GROUP BY s.id
        ORDER BY s.created_at DESC`,
    );

    const visible = [];
    for (const row of rows) {
      const survey = withGating(row, row.audiences);
      const access = await surveyAccess(row.audiences, req);

      // A gated survey is still listed for someone who has not signed in with
      // Discord yet, flagged so the client can say what it needs. Everything
      // else refused stays invisible.
      if (!access.allowed && access.code !== ACCESS.SIGN_IN_REQUIRED) continue;

      const own = access.allowed ? await findOwnResponse(survey, identityFor(survey, req)) : null;
      visible.push({
        slug: survey.slug,
        title: survey.title,
        description: survey.description,
        closesAt: survey.closes_at,
        disclosures: disclosures(survey),
        allowsEdits: survey.allow_response_edits,
        allowsRepeat: allowsRepeat(survey),
        requiresDiscord: !access.allowed,
        guild: access.allowed ? null : access.guild,
        myStatus: own?.status ?? null,
      });
    }

    res.json({ surveys: visible });
  } catch (error) {
    next(error);
  }
});

/**
 * Returns the intro screen for a survey.
 *
 * The disclosures here are what the participant sees before answering
 * anything, which is the point at which every collection toggle is declared.
 */
surveyRouter.get('/:slug', async (req, res, next) => {
  try {
    const result = await loadAccessibleSurvey(req.params.slug, req);
    if (result.error) {
      return res
        .status(result.status)
        .json({ error: result.error, code: result.code, guild: result.guild });
    }

    const { survey } = result;
    const own = await findOwnResponse(survey, identityFor(survey, req));

    const { rows: counts } = await query(
      'SELECT count(*)::int AS n FROM questions WHERE survey_id = $1',
      [survey.id],
    );

    return res.json({
      survey: {
        slug: survey.slug,
        title: survey.title,
        description: survey.description,
        status: survey.status,
        opensAt: survey.opens_at,
        closesAt: survey.closes_at,
        questionCount: counts[0].n,
        disclosures: disclosures(survey),
        allowsEdits: survey.allow_response_edits,
        allowsRepeat: allowsRepeat(survey),
        accepting: isAcceptingResponses(survey),
      },
      myResponse: own
        ? { id: own.id, status: own.status, completedAt: own.completed_at }
        : null,
    });
  } catch (error) {
    return next(error);
  }
});

/**
 * Reports whether a survey is still taking answers.
 *
 * Deliberately minimal - one indexed row, no gate evaluation and no Discord
 * call - because a participant polls it while they answer, so that closing a
 * survey reaches them promptly instead of at their next submit.
 */
surveyRouter.get('/:slug/status', async (req, res, next) => {
  try {
    const { rows } = await query(
      'SELECT status, opens_at, closes_at FROM surveys WHERE slug = $1',
      [req.params.slug],
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Survey not found.' });

    return res.json({ accepting: isAcceptingResponses(rows[0]) });
  } catch (error) {
    return next(error);
  }
});

/**
 * Starts, or resumes, the caller's response.
 *
 * Which of the two it is comes from `startAction`: a survey that allows edits
 * reopens the response already given, one that allows repeats hands out a fresh
 * one, and a survey that allows neither turns a returning respondent away.
 */
surveyRouter.post('/:slug/start', async (req, res, next) => {
  try {
    const result = await loadAccessibleSurvey(req.params.slug, req);
    if (result.error) {
      return res
        .status(result.status)
        .json({ error: result.error, code: result.code, guild: result.guild });
    }

    const { survey } = result;
    if (!isAcceptingResponses(survey)) {
      return res.status(409).json({
        error: 'The survey has been closed and is no longer accepting answers at this time.',
        code: 'survey_closed',
      });
    }

    // Access has already run, so a gated survey has a Discord identity behind
    // it and an anonymous one has its cookie: there is always something to hash.
    const identity = identityFor(survey, req);
    const existing = await findOwnResponse(survey, identity);

    const action = startAction(survey, existing);
    if (action === START.REFUSE) {
      return res.status(409).json({ error: 'You have already completed this survey.' });
    }

    let response = action === START.RESUME ? existing : null;
    if (!response) {
      const country = survey.collect_location ? await countryOf(req) : null;

      // An account is linked only when the survey declares it and the caller
      // is actually signed in; anonymous respondents stay anonymous.
      //
      // `exclusive` mirrors the survey's one-per-person setting: on, and the
      // partial unique index refuses a second row for this respondent, which is
      // what makes two simultaneous starts safe without a lock. Off, and the
      // row is outside the index entirely.
      let created;
      try {
        const { rows } = await query(
          `INSERT INTO responses (survey_id, respondent_hash, user_id, country_code, exclusive)
           VALUES ($1, $2, $3, $4, $5) RETURNING *`,
          [
            survey.id,
            respondentHash(survey.respondent_key, identity),
            survey.collect_identity && req.user ? req.user.id : null,
            country,
            oneResponsePerPerson(survey),
          ],
        );
        created = rows[0];
      } catch (error) {
        // The index just adjudicated a tie: another request created this
        // respondent's one response a moment ago. Theirs stands and this one
        // joins it, rather than the loser of the race seeing an error.
        if (error?.code !== '23505') throw error;
        created = await findOwnResponse(survey, identity);
        if (!created) throw error;
      }
      response = created;
    }

    const { rows: questions } = await query(
      `SELECT q.id, q.position, q.type, q.prompt, q.help_text, q.required, q.config
         FROM questions q WHERE q.survey_id = $1 ORDER BY q.position`,
      [survey.id],
    );

    const { rows: options } = await query(
      `SELECT o.id, o.question_id, o.position, o.label
         FROM question_options o
         JOIN questions q ON q.id = o.question_id
        WHERE q.survey_id = $1 ORDER BY o.position`,
      [survey.id],
    );

    const { rows: answers } = await query(
      'SELECT question_id, value FROM answers WHERE response_id = $1',
      [response.id],
    );

    const optionsByQuestion = new Map();
    for (const option of options) {
      if (!optionsByQuestion.has(option.question_id)) optionsByQuestion.set(option.question_id, []);
      optionsByQuestion.get(option.question_id).push({ id: option.id, label: option.label });
    }

    return res.json({
      response: { id: response.id, status: response.status },
      questions: questions.map((q) => ({
        id: q.id,
        type: q.type,
        prompt: q.prompt,
        helpText: q.help_text,
        required: q.required,
        config: q.config,
        options: optionsByQuestion.get(q.id) ?? [],
      })),
      answers: Object.fromEntries(answers.map((a) => [a.question_id, a.value])),
    });
  } catch (error) {
    return next(error);
  }
});

/**
 * Loads a response the caller owns and is still allowed to write to.
 *
 * @param {string} responseId
 * @param {import('express').Request} req The request, for its identities.
 * @returns {Promise<{response: object, survey: object}|{error: string, status: number}>}
 *   The response and its survey, or a refusal.
 */
async function loadOwnWritableResponse(responseId, req) {
  const { rows } = await query(
    `SELECT r.id, r.survey_id, r.respondent_hash, r.status, r.started_at, r.completed_at,
            s.id AS s_id, s.slug, s.status AS s_status, s.opens_at, s.closes_at,
            s.allow_response_edits, s.collect_timing, s.collect_location, s.collect_identity,
            s.one_response_per_person, s.respondent_key,
            -- Gating is a property of the survey's groups now, so the respondent
            -- key this response is matched by has to be derived the same way it
            -- was when the response was started.
            bool_and(g.require_guild) FILTER (WHERE g.id IS NOT NULL) AS all_gated,
            count(g.id) AS group_count
       FROM responses r
       JOIN surveys s ON s.id = r.survey_id
       LEFT JOIN survey_groups sg ON sg.survey_id = s.id
       LEFT JOIN groups g ON g.id = sg.group_id
      WHERE r.id = $1
      GROUP BY r.id, s.id`,
    [responseId],
  );
  if (rows.length === 0) return { error: 'Response not found.', status: 404 };

  const row = rows[0];
  const survey = {
    id: row.s_id,
    slug: row.slug,
    status: row.s_status,
    opens_at: row.opens_at,
    closes_at: row.closes_at,
    allow_response_edits: row.allow_response_edits,
    one_response_per_person: row.one_response_per_person,
    require_guild: Number(row.group_count) > 0 && row.all_gated === true,
    collect_timing: row.collect_timing,
    collect_location: row.collect_location,
    collect_identity: row.collect_identity,
  };
  const response = {
    id: row.id,
    survey_id: row.survey_id,
    respondent_hash: row.respondent_hash,
    status: row.status,
  };

  // A mismatched hash means the response belongs to someone else. It is
  // reported as "not found" so the route cannot be used to probe for who
  // has responded to a survey. A gated survey identifies its respondents by
  // Discord account, so losing that identity mid-survey reads the same way.
  const identity = identityFor(survey, req);
  if (!identity) return { error: 'Response not found.', status: 404 };

  const expected = respondentHash(row.respondent_key, identity);
  if (!expected.equals(response.respondent_hash)) {
    return { error: 'Response not found.', status: 404 };
  }
  if (!isAcceptingResponses(survey)) {
    // Tagged so the participant's client can show a proper closed screen
    // rather than surfacing this as a validation error on whatever question
    // they happened to be looking at.
    return {
      error: 'The survey has been closed and is no longer accepting answers at this time.',
      status: 409,
      code: 'survey_closed',
    };
  }
  if (response.status === 'completed' && !survey.allow_response_edits) {
    return { error: 'This survey does not allow changing answers.', status: 409 };
  }

  return { response, survey };
}

/** Saves a single answer, so progress survives a closed tab. */
surveyRouter.put('/responses/:id/answers/:questionId', async (req, res, next) => {
  try {
    const loaded = await loadOwnWritableResponse(req.params.id, req);
    if (loaded.error) return res.status(loaded.status).json({ error: loaded.error, code: loaded.code });

    const { rows: questions } = await query(
      'SELECT * FROM questions WHERE id = $1 AND survey_id = $2',
      [req.params.questionId, loaded.response.survey_id],
    );
    if (questions.length === 0) return res.status(404).json({ error: 'Question not found.' });

    const question = questions[0];
    const { rows: options } = await query(
      'SELECT id, label FROM question_options WHERE question_id = $1 ORDER BY position',
      [question.id],
    );

    // Partial saves accept a blank answer even on a required question; the
    // requirement is enforced at submit, so autosave never blocks progress.
    let value;
    try {
      value = normaliseAnswer({ ...question, required: false }, options, req.body?.value);
    } catch (error) {
      if (error instanceof AnswerError) return res.status(400).json({ error: error.message });
      throw error;
    }

    await query(
      `INSERT INTO answers (response_id, question_id, value)
            VALUES ($1, $2, $3)
       ON CONFLICT (response_id, question_id) DO UPDATE
            SET value = EXCLUDED.value, updated_at = now()`,
      [loaded.response.id, question.id, value],
    );

    return res.json({ ok: true, value });
  } catch (error) {
    return next(error);
  }
});

/**
 * Loads the question a file is being attached to, for the caller's response.
 *
 * @param {string} responseId
 * @param {string} questionId
 * @param {import('express').Request} req The request, for its identities.
 * @returns {Promise<{question: object, surveyId: string}|{error: string, status: number}>}
 */
async function loadFileQuestion(responseId, questionId, req) {
  const loaded = await loadOwnWritableResponse(responseId, req);
  if (loaded.error) return loaded;

  const { rows } = await query(
    'SELECT * FROM questions WHERE id = $1 AND survey_id = $2',
    [questionId, loaded.response.survey_id],
  );
  if (rows.length === 0) return { error: 'Question not found.', status: 404 };
  if (rows[0].type !== 'file_upload') {
    return { error: 'This question does not take a file.', status: 400 };
  }
  return { question: rows[0], surveyId: loaded.response.survey_id, responseId: loaded.response.id };
}

/**
 * Stores a file for a file-upload question.
 *
 * The bytes are written to disk under a random key and recorded in
 * answer_files; the answer row then references that file. Re-uploading replaces
 * the previous file, on disk and in the row.
 */
surveyRouter.post(
  '/responses/:id/answers/:questionId/file',
  upload.single('file'),
  async (req, res, next) => {
    try {
      const loaded = await loadFileQuestion(req.params.id, req.params.questionId, req);
      if (loaded.error) return res.status(loaded.status).json({ error: loaded.error, code: loaded.code });
      if (!req.file) return res.status(400).json({ error: 'No file was received.' });

      try {
        validateUpload(loaded.question, req.file);
      } catch (error) {
        if (error instanceof UploadError) return res.status(400).json({ error: error.message });
        throw error;
      }

      const storageKey = await storeFile(loaded.surveyId, req.file.buffer);

      // Replace any previous file for this answer, freeing its disk space.
      const { rows: prior } = await query(
        'SELECT storage_key FROM answer_files WHERE response_id = $1 AND question_id = $2',
        [loaded.responseId, req.params.questionId],
      );

      const { rows } = await query(
        `INSERT INTO answer_files (response_id, question_id, storage_key, original_name, mime, size_bytes)
              VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (response_id, question_id) DO UPDATE
              SET storage_key = EXCLUDED.storage_key,
                  original_name = EXCLUDED.original_name,
                  mime = EXCLUDED.mime,
                  size_bytes = EXCLUDED.size_bytes,
                  created_at = now()
           RETURNING id`,
        [
          loaded.responseId,
          req.params.questionId,
          storageKey,
          req.file.originalname.slice(0, 255),
          // Derived from the extension, never the client-declared type.
          mimeForName(req.file.originalname),
          req.file.size,
        ],
      );

      for (const old of prior) await deleteFile(old.storage_key);

      const value = { fileId: rows[0].id, filename: req.file.originalname, size: req.file.size };
      await query(
        `INSERT INTO answers (response_id, question_id, value)
              VALUES ($1, $2, $3)
         ON CONFLICT (response_id, question_id) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
        [loaded.responseId, req.params.questionId, value],
      );

      return res.json({ ok: true, value });
    } catch (error) {
      if (error?.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ error: 'File is too large.' });
      }
      return next(error);
    }
  },
);

/** Removes a previously uploaded file. */
surveyRouter.delete('/responses/:id/answers/:questionId/file', async (req, res, next) => {
  try {
    const loaded = await loadFileQuestion(req.params.id, req.params.questionId, req);
    if (loaded.error) return res.status(loaded.status).json({ error: loaded.error, code: loaded.code });

    const { rows } = await query(
      'DELETE FROM answer_files WHERE response_id = $1 AND question_id = $2 RETURNING storage_key',
      [loaded.responseId, req.params.questionId],
    );
    for (const file of rows) await deleteFile(file.storage_key);

    await query('DELETE FROM answers WHERE response_id = $1 AND question_id = $2', [
      loaded.responseId,
      req.params.questionId,
    ]);

    return res.json({ ok: true });
  } catch (error) {
    return next(error);
  }
});

/**
 * Records that the participant moved to a question.
 *
 * Only the question id is accepted; the timestamp comes from the database
 * clock, so reported durations cannot be manipulated by the client.
 */
surveyRouter.post('/responses/:id/enter', async (req, res, next) => {
  try {
    const loaded = await loadOwnWritableResponse(req.params.id, req);
    if (loaded.error) return res.status(loaded.status).json({ error: loaded.error, code: loaded.code });
    if (!loaded.survey.collect_timing) return res.json({ ok: true });

    const questionId = req.body?.questionId ?? null;
    if (questionId) {
      const { rows } = await query(
        'SELECT 1 FROM questions WHERE id = $1 AND survey_id = $2',
        [questionId, loaded.response.survey_id],
      );
      if (rows.length === 0) return res.status(404).json({ error: 'Question not found.' });
    }

    await query(
      `INSERT INTO response_events (response_id, question_id, kind) VALUES ($1, $2, 'enter')`,
      [loaded.response.id, questionId],
    );

    return res.json({ ok: true });
  } catch (error) {
    return next(error);
  }
});

/**
 * Validates every answer and marks the response complete.
 *
 * Timing events are collapsed into per-question totals and then deleted, so no
 * per-participant timeline is retained beyond the aggregate.
 */
surveyRouter.post('/responses/:id/submit', async (req, res, next) => {
  try {
    const loaded = await loadOwnWritableResponse(req.params.id, req);
    if (loaded.error) return res.status(loaded.status).json({ error: loaded.error, code: loaded.code });

    const { response, survey } = loaded;

    const { rows: questions } = await query(
      'SELECT * FROM questions WHERE survey_id = $1 ORDER BY position',
      [survey.id],
    );
    const { rows: options } = await query(
      `SELECT o.id, o.label, o.question_id FROM question_options o
         JOIN questions q ON q.id = o.question_id WHERE q.survey_id = $1 ORDER BY o.position`,
      [survey.id],
    );
    const { rows: saved } = await query(
      'SELECT question_id, value FROM answers WHERE response_id = $1',
      [response.id],
    );

    const optionsByQuestion = new Map();
    for (const option of options) {
      if (!optionsByQuestion.has(option.question_id)) optionsByQuestion.set(option.question_id, []);
      optionsByQuestion.get(option.question_id).push(option);
    }
    const savedByQuestion = new Map(saved.map((a) => [a.question_id, a.value]));

    // Conditional logic: a question hidden by its showIf rule is neither
    // enforced nor stored. Its answer is dropped so a value entered before the
    // branch closed cannot linger in the results.
    const visible = new Set(
      visibleQuestions(questions, savedByQuestion).map((question) => question.id),
    );

    // Re-validate everything with the real `required` flag; autosave let blanks
    // through, and a question may have been made required since.
    const errors = {};
    const normalised = new Map();
    for (const question of questions) {
      if (!visible.has(question.id)) continue;
      const raw = savedByQuestion.get(question.id) ?? null;
      try {
        normalised.set(
          question.id,
          normaliseAnswer(question, optionsByQuestion.get(question.id) ?? [], raw),
        );
      } catch (error) {
        if (!(error instanceof AnswerError)) throw error;
        errors[question.id] = error.message;
      }
    }

    if (Object.keys(errors).length > 0) {
      return res.status(400).json({ error: 'Some answers need attention.', questions: errors });
    }

    await transaction(async (client) => {
      let perQuestion = new Map();

      if (survey.collect_timing) {
        await client.query(
          `INSERT INTO response_events (response_id, question_id, kind)
           VALUES ($1, NULL, 'submit')`,
          [response.id],
        );

        const { rows: events } = await client.query(
          'SELECT question_id, at FROM response_events WHERE response_id = $1 ORDER BY at, id',
          [response.id],
        );
        perQuestion = collapseEvents(events);

        await client.query('DELETE FROM response_events WHERE response_id = $1', [response.id]);
      }

      // Timing accumulates across submissions. A participant who comes back to
      // change an answer spends more time on the survey, and the first submit
      // has already consumed its events - so overwriting here would report the
      // second visit's total (often zero) as the whole duration.
      for (const [questionId, value] of normalised) {
        await client.query(
          `INSERT INTO answers (response_id, question_id, value, time_ms)
                VALUES ($1, $2, $3, $4)
           ON CONFLICT (response_id, question_id) DO UPDATE
                SET value = EXCLUDED.value,
                    time_ms = CASE
                      WHEN EXCLUDED.time_ms IS NULL THEN answers.time_ms
                      ELSE COALESCE(answers.time_ms, 0) + EXCLUDED.time_ms
                    END,
                    updated_at = now()`,
          [response.id, questionId, value, perQuestion.get(questionId) ?? null],
        );
      }

      // Drop any stored answer for a now-hidden question, so a value entered
      // before a conditional branch closed does not survive into the results.
      const visibleIds = [...visible];
      await client.query(
        `DELETE FROM answers WHERE response_id = $1 AND NOT (question_id = ANY($2::uuid[]))`,
        [response.id, visibleIds],
      );

      await client.query(
        `UPDATE responses
            SET status = 'completed',
                completed_at = COALESCE(completed_at, now()),
                updated_at = now(),
                duration_ms = CASE
                  WHEN $2::integer IS NULL THEN duration_ms
                  ELSE COALESCE(duration_ms, 0) + $2::integer
                END
          WHERE id = $1`,
        [response.id, survey.collect_timing ? totalDuration(perQuestion) : null],
      );
    });

    // Response quota: close the survey once it reaches its target. Checked
    // after the response is committed so the count includes it.
    if (isPluginEnabled(current().plugins, PLUGINS.QUOTAS)) {
      const { rows: sv } = await query('SELECT plugin_config FROM surveys WHERE id = $1', [
        survey.id,
      ]);
      const max = sv[0]?.plugin_config?.quota?.maxResponses;
      if (max) {
        const { rows: counts } = await query(
          `SELECT count(*)::int AS n FROM responses WHERE survey_id = $1 AND status = 'completed'`,
          [survey.id],
        );
        if (counts[0].n >= Number(max)) {
          await query(
            `UPDATE surveys SET status = 'closed', closed_at = now(), updated_at = now()
              WHERE id = $1 AND status = 'open'`,
            [survey.id],
          );
        }
      }
    }

    return res.json({ ok: true });
  } catch (error) {
    return next(error);
  }
});
