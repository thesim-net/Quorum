import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/**
 * The directory files are stored under.
 *
 * Read from the environment on each call rather than through the config module,
 * so the pure validation helpers here can be imported and unit-tested without a
 * full runtime configuration.
 *
 * @returns {string} Uploads directory path.
 */
const uploadsDir = () => process.env.UPLOADS_DIR ?? '/data/uploads';

/**
 * Storage and validation for uploaded file answers.
 *
 * Files live on a local volume, never a third party, and are named with a
 * random key so a participant's filename can never influence where a file is
 * written or collide with another.
 */

/** Absolute ceiling on any upload, whatever a question configures. */
export const HARD_MAX_BYTES = 25 * 1024 * 1024;

/**
 * Magic-number signatures for the formats we can verify.
 *
 * Each entry lists the byte prefixes that identify a real file of that type,
 * so a renamed file (a .exe called photo.png) is caught rather than trusted on
 * its extension or its client-declared type alone. Formats absent here are
 * plain-text or container types we cannot fingerprint cheaply; those fall back
 * to extension and declared-type checks.
 */
const SIGNATURES = {
  png: [[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]],
  jpg: [[0xff, 0xd8, 0xff]],
  jpeg: [[0xff, 0xd8, 0xff]],
  gif: [[0x47, 0x49, 0x46, 0x38]],
  webp: [[0x52, 0x49, 0x46, 0x46]], // "RIFF"; WEBP marker sits at offset 8
  pdf: [[0x25, 0x50, 0x44, 0x46]], // "%PDF"
  zip: [
    [0x50, 0x4b, 0x03, 0x04],
    [0x50, 0x4b, 0x05, 0x06],
    [0x50, 0x4b, 0x07, 0x08],
  ],
  // Modern Office and OpenDocument files are zip containers.
  docx: [[0x50, 0x4b, 0x03, 0x04]],
  xlsx: [[0x50, 0x4b, 0x03, 0x04]],
  pptx: [[0x50, 0x4b, 0x03, 0x04]],
  odt: [[0x50, 0x4b, 0x03, 0x04]],
  gz: [[0x1f, 0x8b]],
  mp4: [[0x66, 0x74, 0x79, 0x70]], // "ftyp" at offset 4
  mp3: [[0x49, 0x44, 0x33], [0xff, 0xfb], [0xff, 0xf3], [0xff, 0xf2]],
};

/** Where each signature is expected to begin, for the few not at offset 0. */
const SIGNATURE_OFFSET = { mp4: 4 };

/**
 * A trustworthy MIME type derived from the extension.
 *
 * Used instead of the client-declared type, which can claim anything. Files are
 * always served as an attachment regardless, so this is for display only.
 */
const EXTENSION_MIME = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  pdf: 'application/pdf',
  txt: 'text/plain',
  csv: 'text/csv',
  md: 'text/markdown',
  json: 'application/json',
  zip: 'application/zip',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  mp4: 'video/mp4',
  mp3: 'audio/mpeg',
};

/**
 * Resolves a display MIME type from a filename's extension.
 *
 * @param {string} name Original filename.
 * @returns {string} A MIME type, defaulting to a generic binary type.
 */
export function mimeForName(name) {
  return EXTENSION_MIME[extensionOf(name)] ?? 'application/octet-stream';
}

/**
 * Whether a buffer begins with a known signature for an extension.
 *
 * @param {string} ext Lower-case extension without a dot.
 * @param {Buffer} buffer File contents.
 * @returns {boolean|null} True/false when the type can be fingerprinted, null
 *   when it cannot (so the caller should not treat it as a mismatch).
 */
export function signatureMatches(ext, buffer) {
  const candidates = SIGNATURES[ext];
  if (!candidates) return null;

  const offset = SIGNATURE_OFFSET[ext] ?? 0;
  return candidates.some((sig) => {
    if (buffer.length < offset + sig.length) return false;
    return sig.every((byte, i) => buffer[offset + i] === byte);
  });
}

export class UploadError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UploadError';
  }
}

/**
 * Normalises a question's configured accepted formats.
 *
 * @param {*} raw The `acceptedFormats` config value.
 * @returns {string[]} Lower-case extensions without a leading dot.
 */
export function acceptedFormats(raw) {
  if (!Array.isArray(raw)) return [];
  return [
    ...new Set(
      raw
        .map((entry) => String(entry).trim().toLowerCase().replace(/^\./, ''))
        .filter(Boolean),
    ),
  ];
}

/**
 * The size limit a question actually enforces.
 *
 * @param {object} config Question config.
 * @returns {number} Limit in bytes, never above the hard ceiling.
 */
export function maxBytesFor(config) {
  const mb = Number(config?.maxSizeMb);
  if (!Number.isFinite(mb) || mb <= 0) return HARD_MAX_BYTES;
  return Math.min(Math.round(mb * 1024 * 1024), HARD_MAX_BYTES);
}

/**
 * The extension of a filename, lower-cased and without the dot.
 *
 * @param {string} name Original filename.
 * @returns {string} Extension, or empty when there is none.
 */
function extensionOf(name) {
  const match = /\.([a-z0-9]+)$/i.exec(String(name));
  return match ? match[1].toLowerCase() : '';
}

/**
 * Validates an upload against a question's configuration.
 *
 * Checks size, the extension against the allowlist, and, where the format can
 * be fingerprinted, that the file's actual leading bytes match its extension.
 * The last check means a renamed file cannot slip through on its name alone;
 * the client-declared MIME type is never trusted.
 *
 * @param {object} question Question row, including `config`.
 * @param {{originalname: string, size: number, buffer: Buffer, mimetype: string}} file
 * @throws {UploadError} When the file is too large, a disallowed format, or its
 *   contents do not match its claimed type.
 */
export function validateUpload(question, file) {
  const limit = maxBytesFor(question.config);
  if (file.size > limit) {
    throw new UploadError(`File is too large. The limit is ${Math.round(limit / 1024 / 1024)} MB.`);
  }

  const allowed = acceptedFormats(question.config?.acceptedFormats);
  const ext = extensionOf(file.originalname);
  if (allowed.length > 0 && !allowed.includes(ext)) {
    throw new UploadError(`Files of type .${ext || '?'} are not accepted here. Allowed: ${allowed.join(', ')}.`);
  }

  // Fingerprint the contents. `null` means the type is not one we can verify
  // (plain text, csv, and so on), which is not a failure; `false` means the
  // bytes contradict the extension.
  const matches = signatureMatches(ext, file.buffer);
  if (matches === false) {
    throw new UploadError(`This file does not look like a real .${ext} file.`);
  }
}

/**
 * Builds the absolute path for a storage key.
 *
 * @param {string} storageKey On-disk file name.
 * @returns {string} Absolute path under the uploads directory.
 */
export function pathForKey(storageKey) {
  return join(uploadsDir(), storageKey);
}

/**
 * Writes an uploaded file to disk under a fresh random key.
 *
 * @param {string} surveyId Groups files by survey so a survey's uploads can be
 *   removed wholesale.
 * @param {Buffer} buffer File contents.
 * @returns {Promise<string>} The storage key to persist.
 */
export async function storeFile(surveyId, buffer) {
  const storageKey = join(surveyId, randomUUID());
  const target = pathForKey(storageKey);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, buffer);
  return storageKey;
}

/**
 * Deletes a single stored file, ignoring one that is already gone.
 *
 * @param {string} storageKey On-disk file name.
 * @returns {Promise<void>}
 */
export async function deleteFile(storageKey) {
  await rm(pathForKey(storageKey), { force: true });
}

/**
 * Deletes every file belonging to a survey.
 *
 * @param {string} surveyId
 * @returns {Promise<void>}
 */
export async function deleteSurveyFiles(surveyId) {
  await rm(join(uploadsDir(), surveyId), { recursive: true, force: true });
}
