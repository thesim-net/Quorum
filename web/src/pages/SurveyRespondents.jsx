import { useEffect, useMemo, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { api } from '../api.js';
import { buildFilter, describeFilter, isFilterable, toggleFilter } from '../lib/answerFilters.js';
import { duration, truncate, when } from '../lib/format.js';

/**
 * What to call one respondent.
 *
 * A survey that records identity can still hold responses with no name behind
 * them - one given before the survey was gated, or by somebody who has since
 * left the server - so the response number is always there to fall back on.
 * Never render an empty cell where a person should be.
 *
 * @param {object} respondent A row from the respondents endpoint.
 * @param {boolean} identified Whether this survey records identity at all.
 * @returns {string} A name, or the response number.
 */
export function respondentName(respondent, identified) {
  const fallback = `Response #${respondent.ordinal}`;
  if (!identified) return fallback;
  return respondent.displayName || respondent.username || fallback;
}

/**
 * Lists everyone who completed a survey, narrowable by the answers they gave.
 *
 * The charts answer "what did the group say". This page answers "who said it",
 * which is the only question a selection process asks. Filters stack, so a
 * shortlist is built by adding conditions rather than by reading every
 * application in full.
 *
 * @returns {JSX.Element} The page.
 */
export function SurveyRespondents() {
  const { id } = useParams();
  const [params, setParams] = useSearchParams();

  const [data, setData] = useState(null);
  const [results, setResults] = useState(null);
  const [error, setError] = useState(null);
  const [search, setSearch] = useState('');
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState('');

  const filters = params.getAll('answer');
  // The filters go back to the server exactly as they arrived, so the URL is
  // the single source of truth for what is being shown.
  const queryString = filters.map((filter) => `answer=${encodeURIComponent(filter)}`).join('&');

  useEffect(() => {
    setData(null);
    setError(null);
    api(`/admin/surveys/${id}/respondents${queryString ? `?${queryString}` : ''}`)
      .then(setData)
      .catch((e) => setError(e.message));
  }, [id, queryString]);

  // The questions come from the results endpoint, which already knows every
  // answer each one offers - including the ones nobody chose, which are exactly
  // the ones worth filtering for.
  useEffect(() => {
    api(`/admin/surveys/${id}/results`)
      .then(setResults)
      .catch((e) => setError(e.message));
  }, [id]);

  const questions = useMemo(() => results?.questions ?? [], [results]);
  const filterable = useMemo(() => questions.filter(isFilterable), [questions]);
  const chosen = filterable.find((entry) => entry.id === question) ?? null;

  /**
   * Writes a new filter list to the URL.
   *
   * @param {string[]} next The filters to show.
   * @returns {void}
   */
  const applyFilters = (next) => {
    const updated = new URLSearchParams();
    for (const filter of next) updated.append('answer', filter);
    setParams(updated);
  };

  const addFilter = () => {
    if (!question || !answer) return;
    applyFilters(toggleFilter(filters, buildFilter(question, answer)));
    setAnswer('');
  };

  if (error) {
    return (
      <div className="shell">
        <div className="error">{error}</div>
      </div>
    );
  }
  if (!data) return <div className="shell muted">Loading...</div>;

  const needle = search.trim().toLowerCase();
  const shown = data.respondents.filter((respondent) => {
    if (!needle) return true;
    return [respondent.username, respondent.displayName, `#${respondent.ordinal}`]
      .filter(Boolean)
      .some((field) => String(field).toLowerCase().includes(needle));
  });

  return (
    <div className="shell">
      <p>
        <Link to={`/admin/surveys/${id}/results`}>Back to results</Link>
      </p>
      <h1>{results?.survey?.title ?? 'Responses'}</h1>

      <div className="card">
        <h2>Narrow by answer</h2>
        <p className="muted" style={{ fontSize: '0.85rem' }}>
          Two answers to the same question widen the list, showing people who gave either.
          Answers to different questions narrow it, showing only people who gave all of them.
          Filters are kept in the address bar, so a shortlist can be linked or bookmarked.
        </p>

        {filterable.length === 0 ? (
          <p className="muted">
            No question in this survey offers a fixed set of answers to filter on.
          </p>
        ) : (
          <div className="row" style={{ flexWrap: 'wrap', gap: '0.5rem' }}>
            <select
              aria-label="Question to filter on"
              style={{ maxWidth: '100%' }}
              value={question}
              onChange={(e) => {
                setQuestion(e.target.value);
                setAnswer('');
              }}
            >
              <option value="">Choose a question</option>
              {filterable.map((entry) => (
                <option key={entry.id} value={entry.id} title={entry.prompt}>
                  {truncate(entry.prompt, 90)}
                </option>
              ))}
            </select>

            <select
              aria-label="Answer to filter on"
              style={{ maxWidth: '100%' }}
              value={answer}
              disabled={!chosen}
              onChange={(e) => setAnswer(e.target.value)}
            >
              <option value="">Choose an answer</option>
              {(chosen?.offered ?? []).map((option) => (
                <option key={option.key} value={option.key} title={option.label}>
                  {truncate(option.label, 90)} ({option.count})
                </option>
              ))}
            </select>

            <button type="button" disabled={!question || !answer} onClick={addFilter}>
              Add filter
            </button>
          </div>
        )}

        {filters.length > 0 ? (
          <div className="row" style={{ flexWrap: 'wrap', gap: '0.4rem', marginTop: '0.8rem' }}>
            {filters.map((filter) => {
              const described = describeFilter(filter, questions);
              if (!described) return null;
              return (
                <button
                  key={filter}
                  type="button"
                  className={described.known ? undefined : 'danger'}
                  onClick={() => applyFilters(toggleFilter(filters, filter))}
                  // Wrapped rather than truncated: a chip has the room a
                  // dropdown does not, and the question is half of what the
                  // filter means.
                  style={{
                    maxWidth: '100%',
                    whiteSpace: 'normal',
                    textAlign: 'left',
                    lineHeight: 1.35,
                  }}
                >
                  <span className="muted">{described.prompt}</span>
                  <br />
                  {described.answer} &times;
                </button>
              );
            })}
            <button type="button" onClick={() => applyFilters([])}>
              Clear all
            </button>
          </div>
        ) : null}
      </div>

      <div className="card">
        <div className="row">
          <strong>
            {data.filtered
              ? `${data.respondents.length} of ${data.total} respondents`
              : `${data.total} respondents`}
          </strong>
          <input
            type="search"
            placeholder="Search by name"
            aria-label="Search respondents by name"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>

        {shown.length === 0 ? (
          <p className="empty">
            {data.total === 0
              ? 'Nobody has completed this survey yet.'
              : 'No respondent matches every filter.'}
          </p>
        ) : (
          <table className="chart-table">
            <thead>
              <tr>
                <th scope="col">Respondent</th>
                <th scope="col">Submitted</th>
                <th scope="col">Time taken</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((respondent) => (
                <tr key={respondent.id}>
                  <th scope="row">
                    <Link
                      to={`/admin/surveys/${id}/responses/${respondent.id}${
                        queryString ? `?${queryString}` : ''
                      }`}
                    >
                      {respondentName(respondent, data.identified)}
                    </Link>
                    {data.identified && respondent.displayName && respondent.username ? (
                      <>
                        <br />
                        <span className="muted" style={{ fontSize: '0.82rem' }}>
                          {respondent.username}
                        </span>
                      </>
                    ) : null}
                  </th>
                  <td>{when(respondent.submittedAt)}</td>
                  <td>{duration(respondent.durationMs)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

/**
 * One person's full set of answers.
 *
 * Every question is listed in the order it was asked, including the ones this
 * person left blank: a gap in an application is information, and dropping it
 * would make an incomplete response look like a shorter form.
 *
 * @returns {JSX.Element} The page.
 */
export function SurveyResponse() {
  const { id, responseId } = useParams();
  const [params] = useSearchParams();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    setData(null);
    setError(null);
    api(`/admin/surveys/${id}/responses/${responseId}`)
      .then(setData)
      .catch((e) => setError(e.message));
  }, [id, responseId]);

  if (error) {
    return (
      <div className="shell">
        <div className="error">{error}</div>
      </div>
    );
  }
  if (!data) return <div className="shell muted">Loading...</div>;

  // Carried through from the list, so going back returns to the shortlist that
  // was being read rather than to the unfiltered list.
  const back = params.toString();
  const name = data.identified
    ? data.respondent?.displayName || data.respondent?.username || 'Unnamed respondent'
    : 'Anonymous response';

  return (
    <div className="shell">
      <p>
        <Link to={`/admin/surveys/${id}/responses${back ? `?${back}` : ''}`}>
          Back to respondents
        </Link>
      </p>

      <h1>{name}</h1>
      <p className="muted">
        {data.surveyTitle}
        {data.identified && data.respondent?.username && data.respondent?.displayName
          ? ` · ${data.respondent.username}`
          : ''}
        {data.identified && data.respondent?.discordId
          ? ` · Discord id ${data.respondent.discordId}`
          : ''}
      </p>

      <div className="stat-grid">
        <div className="stat">
          <strong>{when(data.submittedAt)}</strong>
          <span>Submitted</span>
        </div>
        {data.durationMs !== null ? (
          <div className="stat">
            <strong>{duration(data.durationMs)}</strong>
            <span>Time taken</span>
          </div>
        ) : null}
        {data.country ? (
          <div className="stat">
            <strong>{data.country}</strong>
            <span>Country</span>
          </div>
        ) : null}
      </div>

      {data.answers.map((entry, index) => (
        <div className="card" key={entry.questionId}>
          <p className="muted" style={{ fontSize: '0.82rem' }}>
            Question {index + 1}
            {entry.required ? ' · required' : ''}
            {entry.timeMs ? ` · ${duration(entry.timeMs)}` : ''}
          </p>
          <h2 style={{ fontSize: '1rem' }}>{entry.prompt}</h2>
          {entry.answered ? (
            <p style={{ whiteSpace: 'pre-wrap' }}>{entry.value}</p>
          ) : (
            <p className="empty">No answer given.</p>
          )}
        </div>
      ))}
    </div>
  );
}
