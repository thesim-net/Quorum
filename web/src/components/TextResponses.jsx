import { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';

/**
 * Dialog listing the written answers to one question.
 *
 * Answers are fetched when it opens rather than with the results, since free
 * text is only wanted when somebody asks to read it.
 *
 * @param {object} props
 * @param {string} props.surveyId
 * @param {string} props.questionId
 * @param {string} props.title Heading for the dialog.
 * @param {() => void} props.onClose Called when the dialog should close.
 * @returns {JSX.Element} The dialog.
 */
export function TextResponses({ surveyId, questionId, title, onClose }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [filter, setFilter] = useState('');
  const closeRef = useRef(null);

  useEffect(() => {
    api(`/admin/surveys/${surveyId}/questions/${questionId}/texts`)
      .then(setData)
      .catch((e) => setError(e.message));
  }, [surveyId, questionId]);

  // Escape closes, and focus starts inside so the dialog is keyboard-usable.
  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const needle = filter.trim().toLowerCase();
  const shown = (data?.answers ?? []).filter(
    (a) => !needle || a.text.toLowerCase().includes(needle),
  );

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
              {data.total} answer{data.total === 1 ? '' : 's'} · {data.distinct} distinct
              {data.identified ? ' · usernames recorded for this survey' : ''}
            </p>

            {data.answers.length > 4 ? (
              <input
                type="text"
                placeholder="Filter answers..."
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
              />
            ) : null}

            <div className="modal-body">
              {shown.length === 0 ? (
                <p className="empty">
                  {data.answers.length === 0 ? 'No written answers.' : 'Nothing matches that.'}
                </p>
              ) : (
                <ul className="response-list">
                  {shown.map((answer, i) => (
                    <li key={`${answer.text}-${i}`}>
                      <p className="response-text">{answer.text}</p>
                      <p className="response-meta">
                        {answer.count > 1 ? `${answer.count} people said this` : ''}
                        {answer.count > 1 && answer.authors.length > 0 ? ' · ' : ''}
                        {answer.authors.length > 0 ? answer.authors.join(', ') : ''}
                      </p>
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
