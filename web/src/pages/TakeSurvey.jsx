import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api.js';
import { QuestionInput } from '../components/QuestionInput.jsx';

/**
 * Whether an answer to a controlling question satisfies a condition.
 *
 * Mirrors the server's evaluation so navigation and enforcement agree.
 *
 * @param {object|undefined} value An answer value.
 * @param {*} expected The value the condition looks for.
 * @returns {boolean} True when it matches.
 */
function answerSatisfies(value, expected) {
  if (!value || value.skipped) return false;
  if (typeof value.optionId === 'string') return value.optionId === expected;
  if (Array.isArray(value.optionIds)) return value.optionIds.includes(expected);
  if (typeof value.bool === 'boolean') return String(value.bool) === String(expected);
  if (typeof value.number === 'number') return String(value.number) === String(expected);
  if (typeof value.text === 'string') return value.text === expected;
  return false;
}

/**
 * Whether a question is currently visible given the answers so far.
 *
 * @param {object} question Question with `config`.
 * @param {Record<string, object>} answers Answers keyed by question id.
 * @returns {boolean} True when the question should be shown.
 */
function isVisible(question, answers) {
  const condition = question.config?.showIf;
  if (!condition || !condition.questionId) return true;
  return answerSatisfies(answers[condition.questionId], condition.equals);
}

/**
 * The wording shown before a participant answers anything.
 *
 * Only the toggles the survey actually has enabled are listed, so the panel
 * never claims to collect something it does not.
 *
 * @param {{disclosures: {timing: boolean, location: boolean, identity: boolean}}} props
 * @returns {JSX.Element|null} The panel, or null when nothing extra is collected.
 */
function Disclosure({ disclosures }) {
  const items = [];
  if (disclosures.identity) items.push('Your Discord username, attached to your answers.');
  if (disclosures.timing) items.push('How long you spend on each question.');
  if (disclosures.location) items.push('The country you are answering from.');

  if (items.length === 0) {
    return (
      <div className="disclosure">
        <h3>Your answers are anonymous</h3>
        <p className="muted">
          This survey records no username, timing, or location. Your answers cannot be traced
          back to you.
        </p>
      </div>
    );
  }

  return (
    <div className="disclosure">
      <h3>Here is the additional data we are collecting from this survey:</h3>
      <ul>
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Survey intro, question flow, and submission.
 *
 * Answers autosave as the participant moves between questions, so a closed tab
 * does not lose progress. Question timing is recorded by the server; the client
 * only reports which question it moved to.
 *
 * @returns {JSX.Element} The page.
 */
export function TakeSurvey() {
  const { slug } = useParams();
  const [intro, setIntro] = useState(null);
  const [session, setSession] = useState(null);
  const [index, setIndex] = useState(0);
  const [answers, setAnswers] = useState({});
  const [errors, setErrors] = useState({});
  const [error, setError] = useState(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const [closed, setClosed] = useState(false);

  const answersRef = useRef(answers);
  answersRef.current = answers;

  useEffect(() => {
    api(`/surveys/${slug}`)
      .then(setIntro)
      .catch((e) => setError(e.message));
  }, [slug]);

  // While someone is answering, watch for the survey being closed under them.
  // Without this they would only find out when they next pressed Next, having
  // possibly spent minutes on answers that can no longer be saved.
  useEffect(() => {
    if (!session || done || closed) return undefined;

    const check = async () => {
      try {
        const { accepting } = await api(`/surveys/${slug}/status`);
        if (!accepting) setClosed(true);
      } catch {
        // A transient failure must not eject someone mid-survey.
      }
    };

    const timer = setInterval(check, 15_000);
    // Also check the moment they return to the tab, which is when a stale
    // session is most likely.
    const onVisible = () => {
      if (document.visibilityState === 'visible') check();
    };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [session, done, closed, slug]);

  /**
   * Persists one answer, ignoring validation errors during autosave.
   *
   * @param {string} questionId
   * @returns {Promise<void>}
   */
  const save = useCallback(
    async (questionId) => {
      if (!session || questionId === undefined) return null;
      try {
        await api(`/surveys/responses/${session.response.id}/answers/${questionId}`, {
          method: 'PUT',
          body: { value: answersRef.current[questionId] ?? null },
        });
        return null;
      } catch (e) {
        // A closed survey is not a problem with this answer; it ends the
        // session outright.
        if (e.payload?.code === 'survey_closed') {
          setClosed(true);
          return null;
        }
        // The server refused the value, so nothing was stored. Report it
        // rather than letting the participant move on believing it was kept -
        // they would otherwise be told at submit that a question they had
        // answered was left blank.
        return e.message;
      }
    },
    [session],
  );

  /**
   * Tells the server the participant moved to a question, so it can time it.
   *
   * @param {string|null} questionId
   * @returns {Promise<void>}
   */
  const markEntered = useCallback(
    async (questionId) => {
      if (!session || !intro?.survey.disclosures.timing) return;
      try {
        await api(`/surveys/responses/${session.response.id}/enter`, {
          method: 'POST',
          body: { questionId },
        });
      } catch {
        // Timing is best-effort; a dropped ping must not block the survey.
      }
    },
    [session, intro],
  );

  /** Starts or resumes the response. */
  const begin = async () => {
    setBusy(true);
    setError(null);
    try {
      const data = await api(`/surveys/${slug}/start`, { method: 'POST' });
      setSession(data);
      setAnswers(data.answers ?? {});
      setIndex(0);
      const firstVisible = data.questions.filter((q) => isVisible(q, data.answers ?? {}))[0];
      await markEntered(firstVisible?.id ?? null);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  /**
   * Moves between questions, saving the current answer on the way out.
   *
   * @param {number} next Index to move to.
   */
  const goTo = async (next) => {
    // Navigation runs over the currently visible questions, so a branch that
    // hides later questions is skipped rather than shown.
    const visibleNow = session.questions.filter((q) => isVisible(q, answersRef.current));
    const current = visibleNow[index];

    // Moving backwards is never blocked: the participant may be going back
    // precisely to fix the thing that is wrong.
    const problem = next > index ? await save(current.id) : null;
    if (problem) {
      setErrors((prev) => ({ ...prev, [current.id]: problem }));
      return;
    }

    if (next < index) await save(current.id);
    setErrors((prev) => ({ ...prev, [current.id]: undefined }));
    setIndex(next);
    await markEntered(visibleNow[next]?.id ?? null);
  };

  /** Saves the final answer and submits the response. */
  const submit = async () => {
    setBusy(true);
    setErrors({});
    setError(null);
    try {
      const visibleNow = session.questions.filter((q) => isVisible(q, answersRef.current));
      const problem = await save(visibleNow[index].id);
      if (problem) {
        setErrors({ [visibleNow[index].id]: problem });
        setBusy(false);
        return;
      }
      await api(`/surveys/responses/${session.response.id}/submit`, { method: 'POST' });
      setDone(true);
    } catch (e) {
      if (e.payload?.code === 'survey_closed') {
        setClosed(true);
        setBusy(false);
        return;
      }
      if (e.payload?.questions) {
        setErrors(e.payload.questions);
        // Jump to the first flagged question, counted over the visible set.
        const visibleNow = session.questions.filter((q) => isVisible(q, answersRef.current));
        const firstBad = visibleNow.findIndex((q) => e.payload.questions[q.id]);
        if (firstBad >= 0) setIndex(firstBad);
      }
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  if (error && !intro) return <div className="shell"><div className="error">{error}</div></div>;
  if (!intro) return <div className="shell muted">Loading...</div>;

  // Closed mid-session. Shown ahead of everything else so the participant is
  // never left typing into a survey that cannot accept it.
  if (closed && !done) {
    return (
      <div className="shell">
        <div className="card">
          <h1>Survey closed</h1>
          <div className="error" style={{ marginTop: '0.75rem' }}>
            The survey has been closed and is no longer accepting answers at this time.
          </div>
          <p className="muted">
            Anything you had already saved has been kept. If it reopens you can pick up where you
            left off.
          </p>
          <Link className="button primary" to="/">
            Back to surveys
          </Link>
        </div>
      </div>
    );
  }

  if (done) {
    return (
      <div className="shell">
        <div className="card">
          <h1>Thanks</h1>
          <p className="muted">
            Your response has been recorded.
            {intro.survey.allowsEdits ? ' You can come back and change your answers any time while this survey is open.' : ''}
          </p>
          <Link to="/">Back to surveys</Link>
        </div>
      </div>
    );
  }

  // Intro screen: disclosures are shown here, before any question is visible.
  if (!session) {
    const alreadyDone = intro.myResponse?.status === 'completed';

    return (
      <div className="shell">
        <div className="card">
          <h1>{intro.survey.title}</h1>
          {intro.survey.description ? <p>{intro.survey.description}</p> : null}
          <p className="muted">
            {intro.survey.questionCount} question{intro.survey.questionCount === 1 ? '' : 's'}
            {intro.survey.allowsEdits ? ' · you can change your answers later' : ''}
          </p>

          <Disclosure disclosures={intro.survey.disclosures} />

          {error ? <div className="error">{error}</div> : null}

          {alreadyDone && !intro.survey.allowsEdits ? (
            <p className="muted">You have already completed this survey.</p>
          ) : (
            <button type="button" className="primary" onClick={begin} disabled={busy}>
              {alreadyDone ? 'Change my answers' : intro.myResponse ? 'Resume' : 'Start survey'}
            </button>
          )}
        </div>
      </div>
    );
  }

  // Only the questions whose conditions are met, recomputed as answers change.
  const visible = session.questions.filter((q) => isVisible(q, answers));
  // A branch may hide the question the participant was on; keep the index valid.
  const safeIndex = Math.min(index, Math.max(0, visible.length - 1));
  const question = visible[safeIndex];
  const last = safeIndex === visible.length - 1;

  if (!question) {
    return <div className="shell muted">Loading...</div>;
  }

  return (
    <div className="shell">
      <div className="progress">
        <div style={{ width: `${((safeIndex + 1) / visible.length) * 100}%` }} />
      </div>

      <div className="card">
        <p className="muted">
          Question {safeIndex + 1} of {visible.length}
          {question.required ? '' : ' · optional'}
        </p>
        <h2>{question.prompt}</h2>
        {question.helpText ? <p className="muted">{question.helpText}</p> : null}

        {errors[question.id] ? <div className="error">{errors[question.id]}</div> : null}

        <QuestionInput
          question={question}
          value={answers[question.id]}
          responseId={session.response.id}
          onChange={(value) => setAnswers((prev) => ({ ...prev, [question.id]: value }))}
        />
      </div>

      {error ? <div className="error">{error}</div> : null}

      <div className="question-nav">
        <button
          type="button"
          onClick={() => goTo(safeIndex - 1)}
          disabled={safeIndex === 0 || busy}
        >
          Back
        </button>
        {last ? (
          <button type="button" className="primary" onClick={submit} disabled={busy}>
            Submit
          </button>
        ) : (
          <button
            type="button"
            className="primary"
            onClick={() => goTo(safeIndex + 1)}
            disabled={busy}
          >
            Next
          </button>
        )}
      </div>
    </div>
  );
}
