import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';

/**
 * Derives the pseudonymous identifier that links a member to their response.
 *
 * The digest is keyed on a per-survey random key and salted with a deployment
 * wide pepper, so the same member produces a different hash in every survey.
 * That prevents anyone with database access from correlating one person's
 * answers across surveys, and rotating a survey's `respondent_key` severs its
 * responses from their authors irreversibly.
 *
 * @param {Buffer} surveyKey The survey's `respondent_key` column.
 * @param {string} discordId The member's Discord snowflake.
 * @returns {Buffer} 32-byte digest suitable for `responses.respondent_hash`.
 */
export function respondentHash(surveyKey, discordId) {
  return createHmac('sha256', surveyKey)
    .update(config.respondentPepper)
    .update(':')
    .update(discordId)
    .digest();
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
