import { fileURLToPath } from 'node:url';
import { pool, query, transaction } from './pool.js';
import { respondentHash } from '../lib/respondent.js';

/**
 * Seeds a demo survey with generated responses, for local preview.
 *
 * Covers every question type so each chart form has something to render, and
 * leaves a few responses unfinished so the abandonment metric is not zero.
 */

const QUESTIONS = [
  {
    type: 'single_choice',
    prompt: 'Which day works best for community game night?',
    required: true,
    config: { allowOther: true },
    options: ['Friday', 'Saturday', 'Sunday', 'Weeknights'],
    // Weights pick how often each option is chosen; the last entry is "other".
    weights: [40, 30, 15, 10, 5],
  },
  {
    type: 'boolean',
    prompt: 'Should we keep the weekly voice chat?',
    required: true,
    config: { trueLabel: 'Keep it', falseLabel: 'Drop it' },
    options: [],
    weights: [78, 22],
  },
  {
    type: 'multi_choice',
    prompt: 'Which channels do you actually read?',
    required: false,
    config: { allowOther: false },
    options: ['#announcements', '#general', '#clips', '#off-topic', '#help'],
    weights: [70, 85, 45, 55, 25],
  },
  {
    type: 'scale',
    prompt: 'How happy are you with moderation right now?',
    required: true,
    config: { min: 1, max: 5, minLabel: 'Unhappy', maxLabel: 'Very happy' },
    options: [],
    weights: [4, 8, 22, 38, 28],
  },
  {
    type: 'ranking',
    prompt: 'Rank what you want us to invest in next.',
    required: true,
    config: {},
    options: ['More events', 'Better bots', 'New channels', 'Server upgrades'],
  },
  {
    type: 'integer',
    prompt: 'Roughly how many hours a week are you around?',
    required: false,
    config: { min: 0, max: 40 },
    options: [],
  },
  {
    type: 'short_text',
    prompt: 'One word for how the server feels lately.',
    required: false,
    config: { maxLength: 40 },
    options: [],
    // Deliberately more distinct answers than a donut can hold, so the chart
    // falls back to bars and the "Other" fold is exercised.
    texts: [
      'Welcoming', 'Chaotic', 'Quiet', 'Friendly', 'Busy', 'Welcoming', 'Friendly',
      'Chill', 'Welcoming', 'Fun', 'Dead', 'Friendly', 'Cosy', 'Loud', 'Welcoming',
      'Chill', 'Growing', 'Friendly', 'Sleepy', 'Fun',
    ],
  },
  {
    type: 'long_text',
    prompt: 'Anything else you want the mods to know?',
    required: false,
    config: { maxLength: 2000 },
    options: [],
    texts: [
      'More events on weekends would be great.',
      'Voice chat quality has been rough lately.',
      'Honestly everything is fine, keep it up.',
      'Could we get a channel for build screenshots?',
      'The bots spam a bit much in #general.',
    ],
  },
];

const COUNTRIES = ['US', 'US', 'US', 'GB', 'GB', 'CA', 'DE', 'AU', 'NL', 'SE', 'BR'];

/**
 * Picks an index according to a weight table.
 *
 * @param {number[]} weights Relative weights; need not sum to anything.
 * @returns {number} The chosen index.
 */
function weightedPick(weights) {
  const total = weights.reduce((sum, w) => sum + w, 0);
  let roll = Math.random() * total;
  for (let i = 0; i < weights.length; i += 1) {
    roll -= weights[i];
    if (roll <= 0) return i;
  }
  return weights.length - 1;
}

/**
 * Builds a plausible answer for one question.
 *
 * @param {object} question Seed definition.
 * @param {Array<{id: string}>} options Persisted options for the question.
 * @returns {object} An `answers.value` payload.
 */
function fakeAnswer(question, options) {
  switch (question.type) {
    case 'single_choice': {
      const pick = weightedPick(question.weights);
      if (pick >= options.length) {
        const custom = ['Monday', 'Any day really', 'Depends on the week'];
        return { optionId: null, other: custom[Math.floor(Math.random() * custom.length)] };
      }
      return { optionId: options[pick].id, other: null };
    }
    case 'boolean':
      return { bool: weightedPick(question.weights) === 0 };
    case 'multi_choice': {
      const chosen = options.filter((_, i) => Math.random() * 100 < question.weights[i]);
      // A required-feeling question still reads better with at least one pick.
      if (chosen.length === 0) chosen.push(options[1] ?? options[0]);
      return { optionIds: chosen.map((o) => o.id), other: null };
    }
    case 'scale':
      return { number: weightedPick(question.weights) + 1 };
    case 'integer':
      return { number: Math.floor(Math.random() * 25) };
    case 'ranking': {
      const order = options.map((o) => o.id);
      for (let i = order.length - 1; i > 0; i -= 1) {
        const j = Math.floor(Math.random() * (i + 1));
        [order[i], order[j]] = [order[j], order[i]];
      }
      return { order };
    }
    case 'short_text':
    case 'long_text': {
      if (Math.random() < 0.15) return { skipped: true };
      return { text: question.texts[Math.floor(Math.random() * question.texts.length)] };
    }
    default:
      return { skipped: true };
  }
}

/**
 * Creates the demo survey and its responses.
 *
 * @param {number} respondents How many completed responses to generate.
 * @returns {Promise<string>} The seeded survey's slug.
 */
export async function seed(respondents = 60) {
  const existing = await query("SELECT id FROM surveys WHERE slug = 'community-check-in'");
  if (existing.rows.length > 0) {
    console.log('Demo survey already seeded.');
    return 'community-check-in';
  }

  return transaction(async (client) => {
    const { rows: surveyRows } = await client.query(
      `INSERT INTO surveys (slug, title, description, status, opened_at,
                            collect_timing, collect_location, collect_identity,
                            allow_response_edits)
       VALUES ('community-check-in', 'Community check-in',
               'A short read on how the server is doing. Takes a couple of minutes.',
               'open', now(), true, true, true, true)
       RETURNING id, respondent_key`,
    );
    const survey = surveyRows[0];

    // A survey must belong to a group, or nobody can take it and no admin can
    // reach it. The demo joins whichever group the deployment already has,
    // taking the first by name so a re-seed lands in the same place.
    await client.query(
      `INSERT INTO survey_groups (survey_id, group_id)
       SELECT $1, id FROM groups ORDER BY name LIMIT 1`,
      [survey.id],
    );

    const persisted = [];
    for (const [index, question] of QUESTIONS.entries()) {
      const { rows } = await client.query(
        `INSERT INTO questions (survey_id, position, type, prompt, required, config)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [survey.id, index, question.type, question.prompt, question.required, question.config],
      );

      const options = [];
      for (const [position, label] of question.options.entries()) {
        const { rows: optionRows } = await client.query(
          `INSERT INTO question_options (question_id, position, label)
           VALUES ($1, $2, $3) RETURNING id`,
          [rows[0].id, position, label],
        );
        options.push(optionRows[0]);
      }

      persisted.push({ ...question, id: rows[0].id, persistedOptions: options });
    }

    for (let i = 0; i < respondents; i += 1) {
      const discordId = `9100000000000${String(i).padStart(5, '0')}`;
      const { rows: userRows } = await client.query(
        `INSERT INTO users (discord_id, username, display_name)
              VALUES ($1, $2, $2)
         ON CONFLICT (discord_id) DO UPDATE SET username = EXCLUDED.username
           RETURNING id`,
        [discordId, `member${i + 1}`],
      );

      // Roughly one in seven starts and never finishes, so the abandonment
      // metric has something real in it.
      const abandoned = i % 7 === 3;
      const durationMs = 90_000 + Math.floor(Math.random() * 240_000);

      const { rows: responseRows } = await client.query(
        `INSERT INTO responses (survey_id, respondent_hash, user_id, status,
                                started_at, completed_at, duration_ms, country_code)
         VALUES ($1, $2, $3, $4, now() - ($5 || ' minutes')::interval, $6, $7, $8)
         RETURNING id`,
        [
          survey.id,
          respondentHash(survey.respondent_key, discordId),
          userRows[0].id,
          abandoned ? 'in_progress' : 'completed',
          String(Math.floor(Math.random() * 4000)),
          abandoned ? null : new Date(),
          abandoned ? null : durationMs,
          COUNTRIES[Math.floor(Math.random() * COUNTRIES.length)],
        ],
      );

      if (abandoned) continue;

      for (const question of persisted) {
        await client.query(
          `INSERT INTO answers (response_id, question_id, value, time_ms) VALUES ($1, $2, $3, $4)`,
          [
            responseRows[0].id,
            question.id,
            fakeAnswer(question, question.persistedOptions),
            5_000 + Math.floor(Math.random() * 55_000),
          ],
        );
      }
    }

    console.log(`Seeded "Community check-in" with ${respondents} respondents.`);
    return 'community-check-in';
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  seed(Number(process.argv[2] ?? 60))
    .then(() => pool.end())
    .catch((error) => {
      console.error('Seed failed:', error);
      process.exit(1);
    });
}
