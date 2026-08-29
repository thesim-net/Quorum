/**
 * Recovers the Discord identity behind responses recorded before the identity
 * columns existed.
 *
 * Those responses stored nothing but `respondent_hash`, which is
 * `HMAC-SHA256(survey.respondent_key, pepper || ':' || discord_id)` and cannot
 * be reversed. It can, however, be *reproduced*: on a guild-gated survey the
 * hashed value is a Discord id, and the set of ids that could have taken the
 * survey is the guild's member list. Hashing every member and looking for the
 * stored digest recovers the author exactly, with no guessing.
 *
 * That only works while three things hold, and the script refuses rather than
 * reporting a maybe if any of them does not:
 *
 *   - the survey is gated on every group, so the hash is over a Discord id and
 *     not over a random browser cookie;
 *   - `respondent_key` has not been rotated since - the anonymise button exists
 *     precisely to make this irrecoverable, and it succeeds;
 *   - `RESPONDENT_PEPPER` is the same value the responses were written under.
 *
 * Read-only unless `--write` is passed.
 *
 * Usage:
 *   node scripts/backfill-respondent-identity.js <survey-id> [--write]
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { pool, query } from '../src/db/pool.js';
import { loadSettings } from '../src/lib/settings.js';
import { guildMembers } from '../src/plugins/discord/discord.js';

const [surveyId, ...flags] = process.argv.slice(2);
const write = flags.includes('--write');

/** Prints usage and exits non-zero. */
function usage(message) {
  console.error(`${message}\n`);
  console.error('Usage: node scripts/backfill-respondent-identity.js <survey-id> [--write]');
  process.exit(1);
}

if (!surveyId) usage('A survey id is required.');
if (!/^[0-9a-f-]{36}$/i.test(surveyId)) usage(`"${surveyId}" is not a survey id.`);

/**
 * Reproduces a response's stored digest for one candidate Discord id.
 *
 * Mirrors `lib/respondent.js#respondentHash` exactly; if that function ever
 * changes, this one has to change with it or every match silently disappears.
 *
 * @param {Buffer} surveyKey The survey's `respondent_key`.
 * @param {string} discordId Candidate Discord user id.
 * @returns {Buffer} 32-byte digest.
 */
const digestFor = (surveyKey, discordId) =>
  createHmac('sha256', surveyKey)
    .update(process.env.RESPONDENT_PEPPER ?? '')
    .update(':')
    .update(discordId)
    .digest();

/** Constant-time compare, matching `hashesMatch`. */
const same = (a, b) => a.length === b.length && timingSafeEqual(a, b);

async function main() {
  if (!process.env.RESPONDENT_PEPPER) {
    usage('RESPONDENT_PEPPER is not set. Without the original pepper nothing will match.');
  }

  await loadSettings();

  const { rows: surveys } = await query(
    'SELECT id, slug, title, respondent_key, collect_identity FROM surveys WHERE id = $1',
    [surveyId],
  );
  if (surveys.length === 0) usage('No survey with that id.');
  const survey = surveys[0];

  // Gated on every group, or the hash is over a browser cookie and the member
  // list is not the candidate set.
  const { rows: audiences } = await query(
    `SELECT g.require_guild
       FROM survey_groups sg JOIN groups g ON g.id = sg.group_id
      WHERE sg.survey_id = $1`,
    [surveyId],
  );
  const gated = audiences.length > 0 && audiences.every((a) => a.require_guild);

  console.log(`Survey:   ${survey.title} (${survey.slug})`);
  console.log(`Gated:    ${gated ? 'yes' : 'no'}`);
  console.log(`Identity: ${survey.collect_identity ? 'collected' : 'not collected'}`);

  if (!gated) {
    console.error(
      '\nThis survey is takeable without Discord, so its responses are hashed over a ' +
        'random browser cookie. There is no candidate set to search and nothing to recover.',
    );
    process.exit(1);
  }

  const { rows: responses } = await query(
    `SELECT id, respondent_hash, status, completed_at, respondent_discord_id
       FROM responses WHERE survey_id = $1 ORDER BY started_at`,
    [surveyId],
  );
  const unresolved = responses.filter((r) => !r.respondent_discord_id);

  console.log(`Responses: ${responses.length} (${unresolved.length} without a recorded identity)`);
  if (unresolved.length === 0) {
    console.log('\nNothing to do.');
    return;
  }

  console.log('\nFetching the guild roster...');
  let members;
  try {
    members = await guildMembers();
  } catch (error) {
    console.error(`\nCould not list guild members: ${error.message}`);
    if (error.status === 403 || error.body?.code === 50001) {
      console.error(
        'Discord refused the listing. Enable the SERVER MEMBERS INTENT for the ' +
          'application (Developer Portal > Bot > Privileged Gateway Intents) and retry.',
      );
    }
    process.exit(1);
  }
  console.log(`Roster:   ${members.length} members`);

  // One digest per member, then a lookup per response, rather than the
  // roster once per response.
  const byDigest = new Map();
  for (const member of members) {
    const id = member.user?.id;
    if (!id) continue;
    byDigest.set(digestFor(survey.respondent_key, id).toString('hex'), member);
  }

  const matches = [];
  for (const response of unresolved) {
    const hash = Buffer.from(response.respondent_hash);
    const member = byDigest.get(hash.toString('hex'));
    // The map already decided it; the constant-time compare is here so the
    // one place that says "these are the same respondent" is the same
    // comparison the application uses.
    if (!member || !same(digestFor(survey.respondent_key, member.user.id), hash)) continue;

    matches.push({
      responseId: response.id,
      status: response.status,
      completedAt: response.completed_at,
      discordId: member.user.id,
      username: member.user.username ?? null,
      displayName: member.nick ?? member.user.global_name ?? null,
    });
  }

  console.log(`\nRecovered ${matches.length} of ${unresolved.length}:\n`);
  for (const m of matches) {
    const when = m.completedAt ? new Date(m.completedAt).toISOString().slice(0, 10) : m.status;
    console.log(`  ${when}  ${m.discordId}  ${m.username}${m.displayName ? ` (${m.displayName})` : ''}`);
  }

  const missed = unresolved.length - matches.length;
  if (missed > 0) {
    console.log(
      `\n${missed} could not be recovered. Either those members have since left the ` +
        'server, or the respondent key has been rotated since they answered.',
    );
  }

  if (!write) {
    console.log('\nDry run. Re-run with --write to record these against the responses.');
    return;
  }

  for (const m of matches) {
    await query(
      `UPDATE responses
          SET respondent_discord_id = $2, respondent_username = $3, respondent_display_name = $4
        WHERE id = $1`,
      [m.responseId, m.discordId, m.username, m.displayName],
    );
  }
  console.log(`\nWrote ${matches.length} identities.`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
