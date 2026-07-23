/**
 * Thin wrapper over the JSON API.
 *
 * Every call is same-origin and carries the session cookie; nginx proxies
 * `/api` through to the backend so there is no cross-origin setup.
 */

export class ApiError extends Error {
  constructor(message, status, payload) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.payload = payload;
  }
}

/**
 * Issues an API request.
 *
 * @param {string} path Path below `/api`.
 * @param {{method?: string, body?: object}} options
 * @returns {Promise<object>} Parsed response body.
 * @throws {ApiError} When the response status is not 2xx.
 */
export async function api(path, { method = 'GET', body } = {}) {
  const response = await fetch(`/api${path}`, {
    method,
    credentials: 'same-origin',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};

  if (!response.ok) {
    throw new ApiError(payload.error ?? 'Request failed.', response.status, payload);
  }
  return payload;
}

/**
 * Uploads a file via multipart, for file-upload answers.
 *
 * @param {string} path Path below `/api`.
 * @param {File} file The file to send.
 * @returns {Promise<object>} Parsed response body.
 * @throws {ApiError} When the response status is not 2xx.
 */
export async function uploadFile(path, file) {
  const form = new FormData();
  form.append('file', file);

  const response = await fetch(`/api${path}`, {
    method: 'POST',
    credentials: 'same-origin',
    body: form,
  });

  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new ApiError(payload.error ?? 'Upload failed.', response.status, payload);
  }
  return payload;
}

/**
 * Triggers a browser download for an export.
 *
 * @param {string} surveyId
 * @param {'csv'|'json'} format
 */
export function downloadExport(surveyId, format) {
  window.location.href = `/api/admin/surveys/${surveyId}/export?format=${format}`;
}
