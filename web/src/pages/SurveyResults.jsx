import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, downloadExport } from '../api.js';
import { QuestionChart } from '../charts/QuestionChart.jsx';
import { TextResponses } from '../components/TextResponses.jsx';
import { FileResponses } from '../components/FileResponses.jsx';

/**
 * Renders a duration in the largest sensible unit.
 *
 * @param {number|null} ms Milliseconds.
 * @returns {string} Formatted duration, or a dash when there is nothing to show.
 */
function duration(ms) {
  if (!ms && ms !== 0) return '-';
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/**
 * A single headline metric.
 *
 * @param {{label: string, value: React.ReactNode}} props
 * @returns {JSX.Element} The tile.
 */
const Stat = ({ label, value }) => (
  <div className="stat">
    <strong>{value}</strong>
    <span>{label}</span>
  </div>
);

/**
 * Average-rank table for a ranking question.
 *
 * Ranks are an ordered scale rather than parts of a whole, so they are shown as
 * positions rather than slices.
 *
 * @param {{ranking: Array<object>}} props
 * @returns {JSX.Element} The table.
 */
const RankingTable = ({ ranking }) => (
  <table className="chart-table">
    <thead>
      <tr>
        <th scope="col">Option</th>
        <th scope="col">Average rank</th>
        <th scope="col">Ranked first</th>
      </tr>
    </thead>
    <tbody>
      {ranking.map((row) => (
        <tr key={row.key}>
          <th scope="row">{row.label}</th>
          <td>{row.averageRank === null ? '-' : row.averageRank.toFixed(2)}</td>
          <td>{row.firstChoices}</td>
        </tr>
      ))}
    </tbody>
  </table>
);

/**
 * Results dashboard for one survey.
 *
 * @returns {JSX.Element} The page.
 */
export function SurveyResults() {
  const { id } = useParams();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [viewing, setViewing] = useState(null);
  const [viewingFiles, setViewingFiles] = useState(null);
  const [winner, setWinner] = useState(null);
  const [drawing, setDrawing] = useState(false);

  /** Draws a raffle winner from the completed responses. */
  const draw = async () => {
    setDrawing(true);
    setError(null);
    try {
      const result = await api(`/admin/surveys/${id}/raffle`, { method: 'POST' });
      setWinner(result.winner);
    } catch (e) {
      setError(e.message);
    } finally {
      setDrawing(false);
    }
  };

  useEffect(() => {
    api(`/admin/surveys/${id}/results`)
      .then(setData)
      .catch((e) => setError(e.message));
  }, [id]);

  if (error) return <div className="shell"><div className="error">{error}</div></div>;
  if (!data) return <div className="shell muted">Loading...</div>;

  const { survey, metrics, countries, questions } = data;

  return (
    <div className="shell">
      <p>
        <Link to="/surveys">Back to surveys</Link>
      </p>
      <h1>{survey.title}</h1>

      <div className="stat-grid">
        <Stat label="Completed" value={metrics.completed} />
        <Stat label="Started" value={metrics.started} />
        <Stat label="Abandoned" value={metrics.abandoned} />
        <Stat label="Completion rate" value={`${Math.round(metrics.completionRate * 100)}%`} />
        {survey.collect.timing ? (
          <>
            <Stat label="Median time" value={duration(metrics.medianTimeMs)} />
            <Stat label="Total time spent" value={duration(metrics.totalTimeMs)} />
          </>
        ) : null}
      </div>

      <div className="card">
        <div className="row">
          <strong>Export</strong>
          <button type="button" onClick={() => downloadExport(id, 'csv')}>
            CSV
          </button>
          <button type="button" onClick={() => downloadExport(id, 'json')}>
            JSON
          </button>
          <span className="muted" style={{ fontSize: '0.82rem' }}>
            Exports include only what this survey told participants it collects.
          </span>
        </div>
      </div>

      {data.plugins?.raffle ? (
        <div className="card">
          <div className="row">
            <strong>Raffle</strong>
            <button
              type="button"
              disabled={metrics.completed === 0 || drawing}
              onClick={draw}
            >
              {drawing ? 'Drawing...' : 'Draw a winner'}
            </button>
            {winner ? (
              <span>
                Winner:{' '}
                <strong>
                  {winner.identified ? winner.name : `Response #${winner.response}`}
                </strong>
              </span>
            ) : (
              <span className="muted" style={{ fontSize: '0.82rem' }}>
                Draws one random completed respondent
                {survey.collect.identity ? '' : ' (anonymous, shown as a response number)'}.
              </span>
            )}
          </div>
        </div>
      ) : null}

      {survey.collect.location && countries.length > 0 ? (
        <div className="card">
          <h2>Where people answered from</h2>
          <QuestionChart
            categories={countries.map((c) => ({
              key: c.code,
              label: c.code === 'Unknown' ? 'Unknown' : c.code,
              count: c.count,
            }))}
            answered={metrics.completed}
          />
        </div>
      ) : null}

      {questions.map((question, index) => (
        <div className="card" key={question.id}>
          <p className="muted">
            Question {index + 1}
            {question.required ? '' : ' · optional'}
            {/* Take-up only says something when answering was a choice. */}
            {!question.required && question.participation !== null
              ? ` · ${Math.round(question.participation * 100)}% participated (${question.participated} of ${question.outOf})`
              : ''}
            {question.medianTimeMs !== null
              ? ` · median ${duration(question.medianTimeMs)} spent here`
              : ''}
          </p>
          <h2>{question.prompt}</h2>

          {question.kind === 'file' ? (
            // Files are listed and downloaded on request, never charted.
            <div className="text-summary">
              <div>
                <strong>{question.answered}</strong> file
                {question.answered === 1 ? '' : 's'} uploaded
              </div>
              <button
                type="button"
                disabled={question.answered === 0}
                onClick={() => setViewingFiles({ id: question.id, prompt: question.prompt })}
              >
                View files
              </button>
            </div>
          ) : question.kind === 'text' ? (
            // Free text is never charted; it is summarised and read on request.
            <div className="text-summary">
              <div>
                <strong>{question.answered}</strong> written answer
                {question.answered === 1 ? '' : 's'}
                {question.distinct !== question.answered ? (
                  <span className="muted"> · {question.distinct} distinct</span>
                ) : null}
              </div>
              <button
                type="button"
                disabled={question.answered === 0}
                onClick={() => setViewing({ id: question.id, prompt: question.prompt })}
              >
                View responses
              </button>
            </div>
          ) : question.type === 'ranking' ? (
            <>
              <RankingTable ranking={question.ranking} />
              <div className="chart-foot">
                <span>{question.answered} answered</span>
              </div>
            </>
          ) : (
            <>
              <QuestionChart
                categories={question.categories ?? []}
                answered={question.answered ?? 0}
                // A scale's points are bounded and ordinal, so the circle stays
                // readable up to the eight hues the palette provides. Wider
                // scales fall back to bars, which show the distribution shape
                // better anyway.
                maxSlices={question.type === 'scale' || question.type === 'integer' ? 8 : undefined}
              />
              {question.stats ? (
                <p className="muted" style={{ fontSize: '0.85rem' }}>
                  min {question.stats.min} · max {question.stats.max} · mean{' '}
                  {question.stats.mean.toFixed(1)} · median {question.stats.median}
                </p>
              ) : null}

              {question.customCount > 0 ? (
                <div className="text-summary">
                  <div>
                    <strong>{question.customCount}</strong> custom answer
                    {question.customCount === 1 ? '' : 's'}
                    <span className="muted"> · {question.customDistinct} distinct</span>
                  </div>
                  <button
                    type="button"
                    onClick={() => setViewing({ id: question.id, prompt: question.prompt })}
                  >
                    View custom answers
                  </button>
                </div>
              ) : null}
            </>
          )}

          {question.skipped ? (
            <p className="muted" style={{ fontSize: '0.82rem' }}>
              {question.skipped} skipped
            </p>
          ) : null}
        </div>
      ))}

      {viewing ? (
        <TextResponses
          surveyId={id}
          questionId={viewing.id}
          title={viewing.prompt}
          onClose={() => setViewing(null)}
        />
      ) : null}

      {viewingFiles ? (
        <FileResponses
          surveyId={id}
          questionId={viewingFiles.id}
          title={viewingFiles.prompt}
          onClose={() => setViewingFiles(null)}
        />
      ) : null}
    </div>
  );
}
