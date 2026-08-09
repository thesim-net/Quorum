import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';

/**
 * Short summary of what a survey collects beyond the answers themselves.
 *
 * @param {{disclosures: {timing: boolean, location: boolean, identity: boolean}}} props
 * @returns {JSX.Element} A row of badges, or an "anonymous" badge when nothing
 *   extra is collected.
 */
function CollectionBadges({ disclosures }) {
  const badges = [];
  if (disclosures.identity) badges.push('Username recorded');
  if (disclosures.timing) badges.push('Timing recorded');
  if (disclosures.location) badges.push('Country recorded');

  if (badges.length === 0) return <span className="badge">Anonymous</span>;

  return (
    <>
      {badges.map((badge) => (
        <span key={badge} className="badge">
          {badge}
        </span>
      ))}
    </>
  );
}

/**
 * Lists the open surveys.
 *
 * No sign-in is needed: anyone with the link can browse and take open surveys.
 * A survey limited to the members of a Discord server is still listed, with a
 * sign-in prompt in place of its start button.
 *
 * @returns {JSX.Element} The page.
 */
export function Home() {
  const [surveys, setSurveys] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    api('/surveys')
      .then((data) => setSurveys(data.surveys))
      .catch((e) => setError(e.message));
  }, []);

  if (error) return <div className="shell"><div className="error">{error}</div></div>;
  if (!surveys) return <div className="shell muted">Loading...</div>;

  return (
    <div className="shell">
      <h1>Available Surveys</h1>

      <div className="disclosure">
        <h3>What these surveys may collect</h3>
        <p className="muted" style={{ margin: '0 0 0.5rem' }}>
          Answers are anonymous unless a survey says otherwise. Depending on the survey, it may
          record your username (if you are signed in), how long you spend answering, or the country
          you answer from. Every survey tells you exactly what it collects before you start, and
          your answers are never shared outside our community or linked across surveys.
        </p>
        <Link to="/privacy">Read the full data privacy page</Link>
      </div>

      {surveys.length === 0 ? (
        <p className="empty">Nothing open right now. Check back later.</p>
      ) : (
        surveys.map((survey) => (
          <div className="card" key={survey.slug}>
            <div className="row">
              <h2 style={{ margin: 0 }}>{survey.title}</h2>
              {survey.myStatus === 'completed' ? <span className="badge">Completed</span> : null}
              {survey.myStatus === 'in_progress' ? <span className="badge">In progress</span> : null}
              {survey.requiresDiscord ? (
                <span className="badge">{survey.guild ? `${survey.guild} members only` : 'Discord members only'}</span>
              ) : null}
            </div>

            {survey.description ? <p>{survey.description}</p> : null}

            <div className="row" style={{ marginTop: '0.5rem' }}>
              <CollectionBadges disclosures={survey.disclosures} />
            </div>

            <p style={{ marginTop: '0.9rem' }}>
              {survey.requiresDiscord ? (
                // Not the admin sign-in: taking a survey proves an identity and
                // creates no account.
                <a className="button primary" href={`/api/auth/discord/respond?slug=${survey.slug}`}>
                  Continue with Discord to take this survey
                </a>
              ) : (
                <Link className="button primary" to={`/s/${survey.slug}`}>
                  {survey.myStatus === 'completed'
                    ? survey.allowsEdits
                      ? 'Change my answers'
                      : survey.allowsRepeat
                        ? 'Answer again'
                        : 'View'
                    : survey.myStatus === 'in_progress'
                      ? 'Resume'
                      : 'Take survey'}
                </Link>
              )}
            </p>
          </div>
        ))
      )}
    </div>
  );
}
