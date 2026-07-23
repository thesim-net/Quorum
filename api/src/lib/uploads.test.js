import test from 'node:test';
import assert from 'node:assert/strict';
import { UploadError, signatureMatches, validateUpload } from './uploads.js';

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
const PDF_MAGIC = Buffer.from('%PDF-1.7\n');

/**
 * Builds a file-upload question.
 *
 * @param {string[]} formats Accepted extensions.
 * @param {number} maxSizeMb Size limit.
 * @returns {object} Question row.
 */
const q = (formats, maxSizeMb = 5) => ({
  type: 'file_upload',
  config: { acceptedFormats: formats, maxSizeMb },
});

test('a real signature matches its extension', () => {
  assert.equal(signatureMatches('png', PNG_MAGIC), true);
  assert.equal(signatureMatches('pdf', PDF_MAGIC), true);
});

test('a wrong signature is rejected', () => {
  assert.equal(signatureMatches('png', PDF_MAGIC), false);
  assert.equal(signatureMatches('pdf', PNG_MAGIC), false);
});

test('unfingerprintable types return null rather than failing', () => {
  assert.equal(signatureMatches('txt', Buffer.from('anything')), null);
  assert.equal(signatureMatches('csv', Buffer.from('a,b,c')), null);
});

test('an oversized file is refused', () => {
  assert.throws(
    () => validateUpload(q(['png'], 1), {
      originalname: 'a.png',
      size: 2 * 1024 * 1024,
      buffer: PNG_MAGIC,
      mimetype: 'image/png',
    }),
    UploadError,
  );
});

test('a disallowed extension is refused', () => {
  assert.throws(
    () => validateUpload(q(['pdf']), {
      originalname: 'a.png',
      size: 10,
      buffer: PNG_MAGIC,
      mimetype: 'image/png',
    }),
    UploadError,
  );
});

test('a file renamed to a permitted extension is caught by its contents', () => {
  // A PDF renamed to .png: extension is allowed, but the bytes betray it.
  assert.throws(
    () => validateUpload(q(['png']), {
      originalname: 'sneaky.png',
      size: PDF_MAGIC.length,
      buffer: PDF_MAGIC,
      mimetype: 'image/png',
    }),
    /does not look like a real \.png/,
  );
});

test('a genuine file passes every check', () => {
  assert.doesNotThrow(() =>
    validateUpload(q(['png']), {
      originalname: 'real.png',
      size: PNG_MAGIC.length,
      buffer: PNG_MAGIC,
      mimetype: 'image/png',
    }),
  );
});

test('a plain-text answer passes without a signature to check', () => {
  assert.doesNotThrow(() =>
    validateUpload(q(['txt']), {
      originalname: 'notes.txt',
      size: 5,
      buffer: Buffer.from('hello'),
      mimetype: 'text/plain',
    }),
  );
});
