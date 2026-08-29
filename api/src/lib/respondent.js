import { createHmac, timingSafeEqual } from 'node:crypto';
import { requiresGuild } from '../plugins/discord/guildGate.js';

/**
 * The deployment-wide pepper mixed into every respondent hash.
 *
 * Read from the environment on each call rather than through the config module,
 * so these pure helpers can be imported and unit-tested without a full runtime
 * configuration. Its presence is still enforced at boot, by config.js.
 *
 * @returns {string} The pepper.
 */
const pepper = () => process.env.RESPONDENT_PEPPER ?? '';

/**
 * Derives the pseudonymous identifier that links a respondent to their response.
 *
 * The digest is keyed on a per-survey random key and salted with a deployment
 * wide pepper, so the same respondent produces a different hash in every
 * survey. That prevents anyone with database access from correlating one
 * person's answers across surveys, and rotating a survey's `respondent_key`
 * severs its responses from their authors irreversibly.
 *
 * @param {Buffer} surveyKey The survey's `respondent_key` column.
 * @param {string} respondentId The caller's opaque respondent id.
 * @returns {Buffer} 32-byte digest suitable for `responses.respondent_hash`.
 */
export function respondentHash(surveyKey, respondentId) {
  return createHmac('sha256', surveyKey)
    .update(pepper())
    .update(':')
    .update(respondentId)
    .digest();
}

/**
 * Chooses which opaque id a survey counts responses by.
 *
 * An anonymous survey counts browsers, because that is all it knows: the signed
 * `quorum_rid` cookie, unchanged and untouched by any of this. A survey gated
 * on the guild already knows exactly who it is talking to, so it counts Discord
 * accounts instead - which is what turns "one response per browser" into "one
 * response per person" without the survey ever storing who those people are.
 *
 * Either way only the HMAC is persisted; the raw id never reaches `responses`.
 *
 * @param {object} survey Survey row.
 * @param {{cookieId: string, discordId: string|null}} identities What this
 *   request carries.
 * @returns {string|null} The id to hash, or null when a gated survey has no
 *   verified Discord identity behind it yet.
 */
export function respondentIdentity(survey, { cookieId, discordId }) {
  return requiresGuild(survey) ? discordId ?? null : cookieId;
}

/**
 * Whether a response should carry the name of the person who gave it.
 *
 * Two conditions, and both are load-bearing. `collect_identity` is the survey
 * saying it wants one, and is what the participant was shown before they
 * answered. Gating is the survey being in a position to know one: an ungated
 * survey identifies respondents by a random browser cookie, so there is no name
 * behind it and recording one would mean inventing it.
 *
 * This is deliberately not "is someone signed in". Reading it that way is what
 * left `collect_identity` surveys with empty usernames: a respondent on a gated
 * survey holds a proved Discord identity and no account at all, so any test
 * that goes looking for a session finds nothing and records nothing.
 *
 * @param {object} survey Survey row, with `require_guild` derived from its
 *   groups.
 * @returns {boolean} True when the identity columns should be written.
 */
export function recordsIdentity(survey) {
  return Boolean(survey?.collect_identity) && requiresGuild(survey);
}

/**
 * Constant-time comparison of two respondent hashes.
 *
 * @param {Buffer} a
 * @param {Buffer} b
 * @returns {boolean} True when the digests match.
 */
export function hashesMatch(a, b) {
  return a.length === b.length && timingSafeEqual(a, b);
}
