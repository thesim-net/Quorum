import { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';

/**
 * Formats a byte count for display.
 *
 * @param {number} bytes
 * @returns {string} Human-readable size.
 */
function humanSize(bytes) {
  if (!bytes) return '0 KB';
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * Dialog listing the files uploaded to one question, with download links.
 *
 * @param {object} props
 * @param {string} props.surveyId
 * @param {string} props.questionId
 * @param {string} props.title Heading for the dialog.
 * @param {() => void} props.onClose
 * @returns {JSX.Element} The dialog.
 */
export function FileResponses({ surveyId, questionId, title, onClose }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const closeRef = useRef(null);

  useEffect(() => {
    api(`/admin/surveys/${surveyId}/questions/${questionId}/files`)
      .then(setData)
      .catch((e) => setError(e.message));
  }, [surveyId, questionId]);

  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal" role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-head">
          <h2>{title}</h2>
          <button type="button" ref={closeRef} onClick={onClose} aria-label="Close">
            Close
          </button>
        </div>

        {error ? <div className="error">{error}</div> : null}
        {!data && !error ? <p className="muted">Loading...</p> : null}

        {data ? (
          <>
            <p className="muted" style={{ fontSize: '0.85rem' }}>
              {data.files.length} file{data.files.length === 1 ? '' : 's'}
              {data.identified ? ' · usernames recorded for this survey' : ''}
            </p>
            <div className="modal-body">
              {data.files.length === 0 ? (
                <p className="empty">No files uploaded.</p>
              ) : (
                <ul className="response-list">
                  {data.files.map((file) => (
                    <li key={file.id}>
                      <div className="file-chip">
                        <a
                          href={`/api/admin/surveys/${surveyId}/files/${file.id}`}
                          className="file-name"
                        >
                          {file.name}
                        </a>
                        <span className="muted">{humanSize(file.sizeBytes)}</span>
                      </div>
                      {file.author ? <p className="response-meta">{file.author}</p> : null}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}
