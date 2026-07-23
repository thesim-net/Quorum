import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api.js';

/** How each derived state is labelled. */
const STATE_LABELS = {
  draft: 'draft',
  scheduled: 'scheduled',
  live: 'open',
  ended: 'ended',
  closed: 'closed',
};

/**
 * Filter tabs, and which derived states each one covers.
 *
 * Grouped by what an admin is actually looking for rather than by the raw
 * status column: a survey past its closing time is finished whether or not
 * anyone pressed Close.
 */
const FILTERS = [
  { key: 'all', label: 'All', states: null },
  { key: 'open', label: 'Open', states: ['live'] },
  { key: 'scheduled', label: 'Scheduled', states: ['scheduled'] },
  { key: 'draft', label: 'Drafts', states: ['draft'] },
  { key: 'closed', label: 'Closed', states: ['closed', 'ended'] },
];

/**
 * Renders a timestamp in the viewer's own timezone.
 *
 * @param {string|null} iso
 * @returns {string} Localised date and time.
 */
const when = (iso) =>
  iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '';

/**
 * Survey management: create, filter, open, close, and delete.
 *
 * Admin configuration lives on its own page; this one is only about surveys.
 *
 * @returns {JSX.Element} The page.
 */
export function AdminSurveys() {
  const [surveys, setSurveys] = useState(null);
  const [title, setTitle] = useState('');
  const [filter, setFilter] = useState('all');
  const [error, setError] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [confirmOverride, setConfirmOverride] = useState(null);
  const [me, setMe] = useState(null);
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();

  /**
   * Whether the signed-in admin holds a permission.
   *
   * @param {string} permission
   * @returns {boolean} True when the action should be offered.
   */
  const can = (permission) => Boolean(me?.permissions?.includes(permission));

  /**
   * Reloads the survey list.
   *
   * @returns {Promise<void>}
   */
  const load = () =>
    api('/admin/surveys')
      .then((data) => setSurveys(data.surveys))
      .catch((e) => setError(e.message));

  useEffect(() => {
    load();
    api('/admin/me').then(setMe).catch(() => setMe(null));
  }, []);

  /** Creates a draft survey and opens it for editing. */
  const create = async () => {
    if (!title.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api('/admin/surveys', {
        method: 'POST',
        body: { title: title.trim() },
      });
      setTitle('');
      // Straight into the editor: a survey with no questions is not useful yet.
      navigate(`/admin/surveys/${result.survey.id}`);
    } catch (e) {
      setError(e.message);
      setBusy(false);
    }
  };

  /**
   * Moves a survey between draft, open, and closed.
   *
   * @param {string} id Survey id.
   * @param {'draft'|'open'|'closed'} status Target status.
   * @param {boolean} overrideSchedule Replace a future scheduled time with now.
   */
  const setStatus = async (id, status, overrideSchedule = false) => {
    setError(null);
    try {
      await api(`/admin/surveys/${id}/status`, {
        method: 'POST',
        body: { status, overrideSchedule },
      });
      setConfirmOverride(null);
      await load();
    } catch (e) {
      if (e.payload?.requiresOverride) {
        setConfirmOverride({
          id,
          status,
          conflict: e.payload.conflict,
          scheduledFor: e.payload.scheduledFor,
        });
      } else {
        setError(e.message);
      }
    }
  };

  /**
   * Permanently deletes a survey and everything attached to it.
   *
   * @param {{id: string}} survey
   */
  const destroy = async (survey) => {
    setError(null);
    try {
      await api(`/admin/surveys/${survey.id}`, { method: 'DELETE' });
      setConfirmDelete(null);
      await load();
    } catch (e) {
      setError(e.message);
    }
  };

  if (!surveys) return <div className="shell muted">Loading...</div>;

  const active = FILTERS.find((f) => f.key === filter) ?? FILTERS[0];
  const visible = active.states
    ? surveys.filter((s) => active.states.includes(s.state))
    : surveys;

  /**
   * Counts the surveys a filter would show, for its tab badge.
   *
   * @param {{states: string[]|null}} entry
   * @returns {number} Matching surveys.
   */
  const countFor = (entry) =>
    entry.states ? surveys.filter((s) => entry.states.includes(s.state)).length : surveys.length;

  return (
    <div className="shell">
      <h1>Surveys</h1>

      {error ? <div className="error">{error}</div> : null}

      {can('surveys.write') ? (
        <div className="card">
          <div className="row">
            <input
              type="text"
              placeholder="New survey title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && create()}
              style={{ flex: 1 }}
            />
            <button type="button" className="primary" onClick={create} disabled={busy}>
              {busy ? 'Creating...' : 'Create survey'}
            </button>
          </div>
        </div>
      ) : null}

      <div className="tabs" role="tablist">
        {FILTERS.map((entry) => (
          <button
            key={entry.key}
            type="button"
            role="tab"
            aria-selected={filter === entry.key}
            className={filter === entry.key ? 'tab tab-on' : 'tab'}
            onClick={() => setFilter(entry.key)}
          >
            {entry.label} <span className="tab-count">{countFor(entry)}</span>
          </button>
        ))}
      </div>

      {visible.length === 0 ? (
        <p className="empty">
          {surveys.length === 0
            ? 'No surveys yet.'
            : `No ${active.label.toLowerCase()} surveys.`}
        </p>
      ) : null}

      {visible.map((survey) => (
        <div className="card" key={survey.id}>
          <div className="row">
            <h2 style={{ margin: 0 }}>{survey.title}</h2>
            <span className={`badge ${survey.state === 'live' ? 'badge-live' : ''}`}>
              {STATE_LABELS[survey.state] ?? survey.status}
            </span>
            {survey.collect.identity ? <span className="badge">Username</span> : null}
            {survey.collect.timing ? <span className="badge">Timing</span> : null}
            {survey.collect.location ? <span className="badge">Country</span> : null}
            {survey.gated ? <span className="badge">Restricted</span> : null}
          </div>

          <p className="muted">
            {survey.questionCount} question{survey.questionCount === 1 ? '' : 's'} ·{' '}
            {survey.completed} completed · {survey.started - survey.completed} abandoned
          </p>

          {survey.opensAt || survey.closesAt ? (
            <p className="muted" style={{ fontSize: '0.85rem' }}>
              {survey.opensAt
                ? `${new Date(survey.opensAt) > new Date() ? 'Scheduled to open' : 'Opened'} ${when(survey.opensAt)}. `
                : ''}
              {survey.closesAt
                ? `${new Date(survey.closesAt) > new Date() ? 'Scheduled to close' : 'Closed'} ${when(survey.closesAt)}.`
                : ''}
            </p>
          ) : null}

          <div className="row">
            {can('surveys.write') ? (
              <Link className="button" to={`/admin/surveys/${survey.id}`}>
                Edit
              </Link>
            ) : null}
            {can('results.read') ? (
              <Link className="button" to={`/admin/surveys/${survey.id}/results`}>
                Results
              </Link>
            ) : null}
            {can('surveys.publish') ? (
              <button
                type="button"
                onClick={() => setStatus(survey.id, survey.status === 'open' ? 'closed' : 'open')}
              >
                {survey.status === 'open' ? 'Close' : 'Open'}
              </button>
            ) : null}
            {can('surveys.delete') ? (
              <button
                type="button"
                className="danger"
                style={{ marginLeft: 'auto' }}
                onClick={() => setConfirmDelete(survey.id)}
              >
                Delete
              </button>
            ) : null}
          </div>

          {confirmOverride?.id === survey.id ? (
            <div className="confirm">
              <h3>Overwrite the schedule?</h3>
              <p>
                This survey is scheduled to {confirmOverride.status === 'open' ? 'open' : 'close'}{' '}
                {when(confirmOverride.scheduledFor)}.{' '}
                {confirmOverride.status === 'open' ? 'Opening' : 'Closing'} it now replaces that
                time with the current one, and the schedule will not apply again.
              </p>
              <div className="row">
                <button type="button" onClick={() => setConfirmOverride(null)}>
                  Keep the schedule
                </button>
                <button
                  type="button"
                  className="danger"
                  onClick={() => setStatus(survey.id, confirmOverride.status, true)}
                >
                  {confirmOverride.status === 'open' ? 'Open now' : 'Close now'}
                </button>
              </div>
            </div>
          ) : null}

          {confirmDelete === survey.id ? (
            <div className="confirm">
              <h3>Are you absolutely certain?</h3>
              <p>
                All data from this survey will be removed completely, including all metrics!
                {survey.completed > 0
                  ? ` ${survey.completed} completed response${survey.completed === 1 ? '' : 's'} will be destroyed.`
                  : ''}{' '}
                This cannot be undone.
              </p>
              <div className="row">
                <button type="button" onClick={() => setConfirmDelete(null)}>
                  Cancel
                </button>
                <button type="button" className="danger" onClick={() => destroy(survey)}>
                  Delete &ldquo;{survey.title}&rdquo; permanently
                </button>
              </div>
            </div>
          ) : null}
        </div>
      ))}
    </div>
  );
}
