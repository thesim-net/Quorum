import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api.js';

const TYPES = [
  ['short_text', 'Short text'],
  ['long_text', 'Long text'],
  ['integer', 'Number'],
  ['scale', 'Scale'],
  ['boolean', 'True / false'],
  ['single_choice', 'Single choice'],
  ['multi_choice', 'Multiple choice'],
  ['ranking', 'Arrange by priority'],
  ['file_upload', 'File upload'],
];

const CHOICE_TYPES = new Set(['single_choice', 'multi_choice', 'ranking']);

/**
 * Converts a stored timestamp into the value a datetime-local input wants.
 *
 * The input has no timezone, so the UTC instant is shifted into the viewer's
 * local zone first - otherwise a time typed as 18:00 reappears offset.
 *
 * @param {string|null} iso Timestamp from the API.
 * @returns {string} `YYYY-MM-DDTHH:mm`, or empty when unset.
 */
function toLocalInput(iso) {
  if (!iso) return '';
  const date = new Date(iso);
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

/**
 * Converts a datetime-local value back into an absolute timestamp.
 *
 * @param {string} value Value from the input, in the viewer's local zone.
 * @returns {string|null} ISO timestamp, or null when cleared.
 */
function fromLocalInput(value) {
  if (!value) return null;
  return new Date(value).toISOString();
}

/**
 * Renders a timestamp for display, in the viewer's own timezone.
 *
 * @param {string|null} iso
 * @returns {string} Localised date and time.
 */
function formatWhen(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

/**
 * A labelled checkbox.
 *
 * @param {{checked: boolean, onChange: (v: boolean) => void, label: string,
 *   hint?: string}} props
 * @returns {JSX.Element} The toggle.
 */
const Toggle = ({ checked, onChange, label, hint }) => (
  <label className="option-row" style={{ alignItems: 'flex-start' }}>
    <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
    <span>
      {label}
      {hint ? (
        <>
          <br />
          <span className="muted" style={{ fontSize: '0.82rem' }}>
            {hint}
          </span>
        </>
      ) : null}
    </span>
  </label>
);

/**
 * Editor for a single question.
 *
 * @param {object} props
 * @param {object} props.question The question being edited.
 * @param {(patch: object) => void} props.onChange Merges a patch into the question.
 * @param {() => void} props.onRemove Deletes the question.
 * @param {(delta: number) => void} props.onMove Reorders the question.
 * @returns {JSX.Element} The editor card.
 */
function QuestionEditor({ question, onChange, onRemove, onMove, conditionalEnabled, priorQuestions = [] }) {
  const isChoice = CHOICE_TYPES.has(question.type);

  const showIf = question.config?.showIf ?? null;
  const controller = priorQuestions.find((q) => q.id === showIf?.questionId) ?? null;

  /**
   * Updates one option's label.
   *
   * @param {number} index
   * @param {string} label
   */
  const setOption = (index, label) => {
    const options = [...(question.options ?? [])];
    options[index] = { ...options[index], label };
    onChange({ options });
  };

  return (
    <div className="card">
      <div className="row">
        <select
          value={question.type}
          onChange={(e) => onChange({ type: e.target.value, options: question.options ?? [] })}
          style={{ maxWidth: 200 }}
        >
          {TYPES.map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
        <span className="spacer" style={{ marginLeft: 'auto' }} />
        <button type="button" onClick={() => onMove(-1)}>
          Up
        </button>
        <button type="button" onClick={() => onMove(1)}>
          Down
        </button>
        <button type="button" className="danger" onClick={onRemove}>
          Delete
        </button>
      </div>

      <label>
        <span className="field-label">Question</span>
        <input
          type="text"
          value={question.prompt}
          onChange={(e) => onChange({ prompt: e.target.value })}
        />
      </label>

      <label>
        <span className="field-label">Help text (optional)</span>
        <input
          type="text"
          value={question.helpText ?? ''}
          onChange={(e) => onChange({ helpText: e.target.value })}
        />
      </label>

      <Toggle
        checked={question.required !== false}
        onChange={(required) => onChange({ required })}
        label="Required"
      />

      {(question.type === 'short_text' || question.type === 'long_text') && (
        <label>
          <span className="field-label">Character limit</span>
          <input
            type="number"
            min={1}
            value={question.config?.maxLength ?? (question.type === 'long_text' ? 2000 : 200)}
            onChange={(e) =>
              onChange({ config: { ...question.config, maxLength: Number(e.target.value) } })
            }
          />
        </label>
      )}

      {(question.type === 'integer' || question.type === 'scale') && (
        <div className="row">
          <label style={{ flex: 1 }}>
            <span className="field-label">Minimum</span>
            <input
              type="number"
              placeholder="No minimum"
              value={question.config?.min ?? ''}
              // An empty field means "no limit". Number('') is 0, so clearing
              // it would otherwise silently impose a minimum of zero.
              onChange={(e) =>
                onChange({
                  config: {
                    ...question.config,
                    min: e.target.value === '' ? undefined : Number(e.target.value),
                  },
                })
              }
            />
          </label>
          <label style={{ flex: 1 }}>
            <span className="field-label">Maximum</span>
            <input
              type="number"
              placeholder="No maximum"
              value={question.config?.max ?? ''}
              onChange={(e) =>
                onChange({
                  config: {
                    ...question.config,
                    max: e.target.value === '' ? undefined : Number(e.target.value),
                  },
                })
              }
            />
          </label>
        </div>
      )}

      {question.type === 'boolean' && (
        <>
          <div className="row">
            <label style={{ flex: 1 }}>
              <span className="field-label">Label for true (optional)</span>
              <input
                type="text"
                value={question.config?.trueLabel ?? ''}
                placeholder="True"
                onChange={(e) =>
                  onChange({ config: { ...question.config, trueLabel: e.target.value } })
                }
              />
            </label>
            <label style={{ flex: 1 }}>
              <span className="field-label">Label for false (optional)</span>
              <input
                type="text"
                value={question.config?.falseLabel ?? ''}
                placeholder="False"
                onChange={(e) =>
                  onChange({ config: { ...question.config, falseLabel: e.target.value } })
                }
              />
            </label>
          </div>
          <p className="muted" style={{ fontSize: '0.82rem', marginTop: 0 }}>
            Leave blank to use True and False. Participants will see{' '}
            <strong>{(question.config?.trueLabel ?? '').trim() || 'True'}</strong> and{' '}
            <strong>{(question.config?.falseLabel ?? '').trim() || 'False'}</strong>.
          </p>
        </>
      )}

      {isChoice && (
        <>
          <span className="field-label">Options</span>
          {(question.options ?? []).map((option, index) => (
            <div className="row" key={option.id ?? `new-${index}`} style={{ marginBottom: '0.4rem' }}>
              <input
                type="text"
                value={option.label}
                onChange={(e) => setOption(index, e.target.value)}
                style={{ flex: 1 }}
              />
              <button
                type="button"
                className="danger"
                onClick={() =>
                  onChange({ options: question.options.filter((_, i) => i !== index) })
                }
              >
                Remove
              </button>
            </div>
          ))}
          <button
            type="button"
            onClick={() => onChange({ options: [...(question.options ?? []), { label: '' }] })}
          >
            Add option
          </button>

          {question.type === 'file_upload' && (
        <div style={{ marginTop: '0.5rem' }}>
          <label>
            <span className="field-label">Maximum file size (MB, up to 25)</span>
            <input
              type="number"
              min={1}
              max={25}
              value={question.config?.maxSizeMb ?? 10}
              onChange={(e) =>
                onChange({
                  config: {
                    ...question.config,
                    maxSizeMb: Math.min(25, Math.max(1, Number(e.target.value) || 1)),
                  },
                })
              }
            />
          </label>
          <label>
            <span className="field-label">Accepted formats</span>
            <input
              type="text"
              placeholder="pdf, png, jpg"
              value={(question.config?.acceptedFormats ?? []).join(', ')}
              onChange={(e) =>
                onChange({
                  config: {
                    ...question.config,
                    // Stored as bare, lower-case extensions.
                    acceptedFormats: e.target.value
                      .split(',')
                      .map((f) => f.trim().toLowerCase().replace(/^\./, ''))
                      .filter(Boolean),
                  },
                })
              }
            />
            <span className="muted" style={{ fontSize: '0.82rem' }}>
              Comma-separated file extensions. At least one is required. The server checks the size
              and inspects each file&rsquo;s headers to verify it matches the type it claims to be.
            </span>
          </label>
        </div>
      )}

      {question.type === 'multi_choice' && (
            <div className="row" style={{ marginTop: '0.75rem' }}>
              <label style={{ flex: 1 }}>
                <span className="field-label">Minimum selections</span>
                <input
                  type="number"
                  min={0}
                  max={(question.options ?? []).length}
                  placeholder="No minimum"
                  value={question.config?.minSelections ?? ''}
                  onChange={(e) =>
                    onChange({
                      config: {
                        ...question.config,
                        minSelections: e.target.value === '' ? undefined : Number(e.target.value),
                      },
                    })
                  }
                />
              </label>
              <label style={{ flex: 1 }}>
                <span className="field-label">Maximum selections</span>
                <input
                  type="number"
                  min={0}
                  // Cannot exceed the number of options that exist to pick.
                  max={(question.options ?? []).length}
                  placeholder="No maximum"
                  value={question.config?.maxSelections ?? ''}
                  onChange={(e) =>
                    onChange({
                      config: {
                        ...question.config,
                        maxSelections: e.target.value === '' ? undefined : Number(e.target.value),
                      },
                    })
                  }
                />
              </label>
            </div>
          )}

          {question.type !== 'ranking' && (
            <div style={{ marginTop: '0.75rem' }}>
              <Toggle
                checked={!!question.config?.allowOther}
                onChange={(allowOther) =>
                  onChange({ config: { ...question.config, allowOther } })
                }
                label="Allow a custom answer"
                hint="Custom answers each become their own category in the results."
              />
            </div>
          )}
        </>
      )}

      {conditionalEnabled && priorQuestions.length > 0 ? (
        <div style={{ marginTop: '0.75rem' }}>
          <span className="field-label">Show only if</span>
          <div className="row">
            <select
              value={showIf?.questionId ?? ''}
              onChange={(e) =>
                onChange({
                  config: {
                    ...question.config,
                    // Clearing the controller removes the condition entirely.
                    showIf: e.target.value ? { questionId: e.target.value, equals: '' } : undefined,
                  },
                })
              }
              style={{ flex: 1 }}
            >
              <option value="">Always show this question</option>
              {priorQuestions.map((q) => (
                <option key={q.id} value={q.id}>
                  {q.prompt || '(untitled question)'}
                </option>
              ))}
            </select>

            {controller ? (
              <select
                value={showIf?.equals ?? ''}
                onChange={(e) =>
                  onChange({
                    config: {
                      ...question.config,
                      showIf: { questionId: controller.id, equals: e.target.value },
                    },
                  })
                }
                style={{ flex: 1 }}
              >
                <option value="">is answered as...</option>
                {controller.type === 'boolean'
                  ? [
                      ['true', controller.config?.trueLabel?.trim() || 'True'],
                      ['false', controller.config?.falseLabel?.trim() || 'False'],
                    ].map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))
                  : (controller.options ?? []).map((option) => (
                      <option key={option.id} value={option.id}>
                        {option.label}
                      </option>
                    ))}
              </select>
            ) : null}
          </div>
          <span className="muted" style={{ fontSize: '0.82rem' }}>
            Leave as &ldquo;Always show&rdquo; to show this question to everyone.
          </span>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Survey settings and question builder.
 *
 * @returns {JSX.Element} The page.
 */
export function SurveyEditor() {
  const { id } = useParams();
  const [survey, setSurvey] = useState(null);
  const [questions, setQuestions] = useState([]);
  const [discord, setDiscord] = useState({ guild: null, roles: [], channels: [] });
  // Whether a Discord server is connected at all, and what it is called. Comes
  // with the survey so the gate section can render before - or without - the
  // roles and channels arriving.
  const [server, setServer] = useState({ ready: false, guildName: null });
  const [plugins, setPlugins] = useState({});
  const [responses, setResponses] = useState(null);
  const [pendingLoss, setPendingLoss] = useState(null);
  const [confirmAnonymise, setConfirmAnonymise] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [me, setMe] = useState(null);
  const navigate = useNavigate();

  /**
   * Whether the signed-in admin holds a permission.
   *
   * @param {string} permission
   * @returns {boolean} True when the action should be offered.
   */
  const can = (permission) => Boolean(me?.permissions?.includes(permission));
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [status, setStatus] = useState(null);
  const [error, setError] = useState(null);

  // The success note is transient; unsaved edits clear it immediately so it
  // never claims the current state is saved when it is not.
  useEffect(() => {
    if (!saved) return undefined;
    const timer = setTimeout(() => setSaved(false), 4000);
    return () => clearTimeout(timer);
  }, [saved]);

  // Warn before losing edits to a closed tab or a Back navigation.
  useEffect(() => {
    if (!dirty) return undefined;
    const warn = (e) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  useEffect(() => {
    api(`/admin/surveys/${id}`)
      .then((data) => {
        setSurvey(data.survey);
        setQuestions(data.questions);
        setResponses(data.responses);
        setPlugins(data.plugins ?? {});
        setServer(data.discord ?? { ready: false, guildName: null });

        // Roles and channels come from the discord plugin, so they are only
        // asked for when a server is connected; the gate card explains itself
        // otherwise, and never waits on this to render.
        if (data.discord?.ready) {
          api('/plugin/discord/guild')
            .then(setDiscord)
            .catch(() => setDiscord({ guild: null, roles: [], channels: [] }));
        }
      })
      .catch((e) => setError(e.message));

    api('/admin/me').then(setMe).catch(() => setMe(null));
  }, [id]);

  /** Permanently deletes this survey and returns to the list. */
  const destroy = async () => {
    setError(null);
    setBusy(true);
    try {
      await api(`/admin/surveys/${id}`, { method: 'DELETE' });
      navigate('/admin');
    } catch (e) {
      setError(e.message);
      setBusy(false);
    }
  };

  /**
   * Merges a patch into the survey being edited.
   *
   * @param {object} patch
   */
  const patch = (fields) => {
    setSurvey((prev) => ({ ...prev, ...fields }));
    setDirty(true);
    setSaved(false);
  };

  /**
   * Merges a change into the survey's per-plugin configuration.
   *
   * @param {object} fields Keys to set on plugin_config; a value of undefined
   *   removes that key.
   */
  const patchPlugin = (fields) => {
    setSurvey((prev) => {
      const next = { ...(prev.pluginConfig ?? {}), ...fields };
      for (const key of Object.keys(fields)) {
        if (fields[key] === undefined) delete next[key];
      }
      return { ...prev, pluginConfig: next };
    });
    setDirty(true);
    setSaved(false);
  };

  /**
   * Applies a change to the question list and marks the editor dirty.
   *
   * @param {(prev: object[]) => object[]} updater Receives the current questions.
   */
  const editQuestions = (updater) => {
    setQuestions(updater);
    setDirty(true);
    setSaved(false);
  };

  /**
   * Persists settings and the question set.
   *
   * A single Save covers both. When saving would destroy existing answers the
   * server refuses and reports how many; that turns into a confirmation here
   * rather than a second button the user has to know to reach for.
   *
   * @param {boolean} force Proceed even though answers will be discarded.
   */
  const save = async (force = false) => {
    setError(null);
    setPendingLoss(null);
    setSaved(false);
    setBusy(true);
    try {
      await api(`/admin/surveys/${id}`, { method: 'PATCH', body: survey });
      await api(`/admin/surveys/${id}/questions${force ? '?force=1' : ''}`, {
        method: 'PUT',
        body: { questions },
      });
      // Reload so the editor shows exactly what was stored, including ids
      // assigned to newly created questions and options.
      const fresh = await api(`/admin/surveys/${id}`);
      setSurvey(fresh.survey);
      setQuestions(fresh.questions);
      setResponses(fresh.responses);
      setSaved(true);
      setDirty(false);
    } catch (e) {
      if (e.payload?.requiresForce) {
        setPendingLoss(e.payload.answersAffected);
      } else {
        setError(e.message);
      }
    } finally {
      setBusy(false);
    }
  };

  /** Permanently detaches every response from its author. */
  const anonymise = async () => {
    setError(null);
    setBusy(true);
    try {
      await api(`/admin/surveys/${id}/anonymise`, { method: 'POST' });
      const fresh = await api(`/admin/surveys/${id}`);
      setSurvey(fresh.survey);
      setResponses(fresh.responses);
      setConfirmAnonymise(false);
      setStatus('Responses are now permanently anonymous.');
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  if (error && !survey) return <div className="shell"><div className="error">{error}</div></div>;
  if (!survey) return <div className="shell muted">Loading...</div>;

  // The real server name wherever it is known, and generic wording when it is
  // not: naming it is worth having, but never worth blocking the editor for.
  const serverName = discord.guild?.name || server.guildName || 'the connected Discord server';

  return (
    <div className="shell">
      <p>
        <Link to="/admin/surveys">Back to surveys</Link>
      </p>
      <h1>Edit survey</h1>

      {error ? <div className="error">{error}</div> : null}
      {status ? <p className="muted">{status}</p> : null}

      <div className="card">
        <h2>Details</h2>
        <label>
          <span className="field-label">Title</span>
          <input
            type="text"
            value={survey.title}
            onChange={(e) => patch({ title: e.target.value })}
          />
        </label>
        <label>
          <span className="field-label">Description</span>
          <textarea
            rows={3}
            value={survey.description ?? ''}
            onChange={(e) => patch({ description: e.target.value })}
          />
        </label>
      </div>

      <div className="card">
        <h2>Participation</h2>
        <Toggle
          checked={survey.oneResponsePerPerson !== false}
          onChange={(oneResponsePerPerson) => patch({ oneResponsePerPerson })}
          label="Allow one response per person"
          hint={
            survey.requireGuild
              ? 'Counted per Discord account, since this survey knows who is answering.'
              : 'Counted per browser, which is all an anonymous survey can know. Switch it off to let the same person answer as often as they like.'
          }
        />
        <Toggle
          checked={!!survey.allowResponseEdits}
          onChange={(allowResponseEdits) => patch({ allowResponseEdits })}
          label="Let people change their answers after submitting"
          hint={
            survey.oneResponsePerPerson === false
              ? 'Coming back reopens their most recent response rather than starting another one.'
              : 'They can reopen their response at any time while the survey is open.'
          }
        />
      </div>

      <div className="card">
        <h2>Schedule</h2>
        <p className="muted" style={{ fontSize: '0.85rem' }}>
          Optional. A scheduled survey still has to be opened, then it starts and stops on its own
          at these times. You can always open or close it by hand.
        </p>

        <div className="row">
          <label style={{ flex: 1 }}>
            <span className="field-label">Opens</span>
            <input
              type="datetime-local"
              value={toLocalInput(survey.opensAt)}
              onChange={(e) => patch({ opensAt: fromLocalInput(e.target.value) })}
            />
          </label>
          <label style={{ flex: 1 }}>
            <span className="field-label">Closes</span>
            <input
              type="datetime-local"
              value={toLocalInput(survey.closesAt)}
              onChange={(e) => patch({ closesAt: fromLocalInput(e.target.value) })}
            />
          </label>
        </div>

        {survey.opensAt && survey.closesAt &&
        new Date(survey.opensAt) >= new Date(survey.closesAt) ? (
          <div className="error">The closing time must be after the opening time.</div>
        ) : null}

        {survey.opensAt || survey.closesAt ? (
          <p className="muted" style={{ fontSize: '0.85rem' }}>
            {survey.opensAt ? `Opens ${formatWhen(survey.opensAt)}. ` : ''}
            {survey.closesAt ? `Closes ${formatWhen(survey.closesAt)}.` : ''}
          </p>
        ) : null}
      </div>

      <div className="card">
        <h2>What this survey collects</h2>
        <p className="muted" style={{ fontSize: '0.85rem' }}>
          Anything enabled here is shown to participants before they answer a single question.
        </p>

        <Toggle
          checked={!!survey.collectIdentity}
          onChange={(collectIdentity) => patch({ collectIdentity })}
          label="Record which member submitted each response"
          hint="Switching this off deletes the usernames already recorded here."
        />
        <Toggle
          checked={!!survey.collectTiming}
          onChange={(collectTiming) => patch({ collectTiming })}
          label="Record time spent per question"
          hint="Measured by the server as people move through the survey."
        />
        <Toggle
          checked={!!survey.collectLocation}
          onChange={(collectLocation) => patch({ collectLocation })}
          label="Record country of origin"
          hint="Country only. IP addresses are never stored."
        />
      </div>

      {plugins.announcements || plugins.reminders || plugins.quotas ? (
        <div className="card">
          <h2>Plugins</h2>
          <p className="muted" style={{ fontSize: '0.85rem' }}>
            Settings for the plugins enabled on this deployment. Manage which plugins exist under
            Admin, Plugins.
          </p>

          {plugins.announcements ? (
            <label>
              <span className="field-label">Announcement channel</span>
              <select
                value={survey.pluginConfig?.announceChannelId ?? ''}
                onChange={(e) =>
                  patchPlugin({ announceChannelId: e.target.value || undefined })
                }
              >
                <option value="">Do not announce</option>
                {discord.channels.map((channel) => (
                  <option key={channel.id} value={channel.id}>
                    #{channel.name}
                  </option>
                ))}
              </select>
              <span className="muted" style={{ fontSize: '0.82rem' }}>
                Posts when the survey opens and closes. The bot needs Send Messages in this channel.
              </span>
            </label>
          ) : null}

          {plugins.reminders ? (
            <label>
              <span className="field-label">Remind this many hours before closing</span>
              <input
                type="number"
                min={1}
                placeholder="No reminder"
                value={survey.pluginConfig?.remindHoursBeforeClose ?? ''}
                onChange={(e) =>
                  patchPlugin({
                    remindHoursBeforeClose:
                      e.target.value === '' ? undefined : Math.max(1, Number(e.target.value)),
                  })
                }
              />
              <span className="muted" style={{ fontSize: '0.82rem' }}>
                Needs a closing time (above) and an announcement channel.
              </span>
            </label>
          ) : null}

          {plugins.quotas ? (
            <label>
              <span className="field-label">Close automatically after this many responses</span>
              <input
                type="number"
                min={1}
                placeholder="No limit"
                value={survey.pluginConfig?.quota?.maxResponses ?? ''}
                onChange={(e) =>
                  patchPlugin({
                    quota:
                      e.target.value === ''
                        ? undefined
                        : { maxResponses: Math.max(1, Number(e.target.value)) },
                  })
                }
              />
            </label>
          ) : null}
        </div>
      ) : null}

      {server.ready ? (
      <div className="card">
        <h2>Who can take it</h2>

        {/* One decision first - is this survey for the server or for anyone -
            and only then the narrowing, so the two are never mistaken for
            unrelated settings. */}
        <Toggle
          checked={!!survey.requireGuild}
          onChange={(requireGuild) => patch({ requireGuild })}
          label={`Only members of ${serverName} can take this survey`}
          hint="Participants sign in with Discord and their membership is checked before the survey opens. Left off, the survey is truly anonymous: no sign-in, and Discord is never contacted."
        />

        {survey.requireGuild ? (
          <>
            <p className="muted" style={{ fontSize: '0.85rem', marginTop: '1rem' }}>
              Optionally narrow it further to who <strong>from {serverName}</strong> may take it.
              Leave both lists empty and every member can.
            </p>

            <label>
              <span className="field-label">Roles (any one of these)</span>
              <select
                multiple
                size={Math.min(8, Math.max(3, discord.roles.length))}
                value={survey.gateRoleIds ?? []}
                onChange={(e) =>
                  patch({ gateRoleIds: [...e.target.selectedOptions].map((o) => o.value) })
                }
              >
                {discord.roles.map((role) => (
                  <option key={role.id} value={role.id}>
                    {role.name}
                  </option>
                ))}
              </select>
            </label>

            <label>
              <span className="field-label">Channels (can see any one of these)</span>
              <select
                multiple
                size={Math.min(8, Math.max(3, discord.channels.length))}
                value={survey.gateChannelIds ?? []}
                onChange={(e) =>
                  patch({ gateChannelIds: [...e.target.selectedOptions].map((o) => o.value) })
                }
              >
                {discord.channels.map((channel) => (
                  <option key={channel.id} value={channel.id}>
                    #{channel.name}
                  </option>
                ))}
              </select>
            </label>

            {/* Both lists populated is an AND, which is narrower than it looks
                and the easiest way to lock everyone out. Say so plainly. */}
            {(survey.gateRoleIds?.length ?? 0) > 0 &&
            (survey.gateChannelIds?.length ?? 0) > 0 ? (
              <div className="confirm">
                <h3>Both requirements must be met</h3>
                <p style={{ marginBottom: 0 }}>
                  A member needs one of the {survey.gateRoleIds.length} selected role
                  {survey.gateRoleIds.length === 1 ? '' : 's'} <strong>and</strong> must be able to
                  see one of the {survey.gateChannelIds.length} selected channel
                  {survey.gateChannelIds.length === 1 ? '' : 's'}. Anyone missing either is refused.
                </p>
              </div>
            ) : null}
          </>
        ) : null}
      </div>
      ) : (
      <div className="card">
        <h2>Who can take it</h2>
        {survey.requireGuild ? (
          // Gated, with nothing left to check it against. The toggle stays so
          // this is a decision the admin can still reverse from here.
          <>
            <div className="error">
              This survey is limited to the members of a Discord server, and no server is connected,
              so nobody can take it. Connect one under Admin, Plugins, or turn the limit off here.
            </div>
            <Toggle
              checked
              onChange={(requireGuild) => patch({ requireGuild })}
              label="Only members of a Discord server can take this survey"
            />
          </>
        ) : (
          <p className="muted" style={{ marginBottom: 0 }}>
            Anyone with the link, anonymously. Limiting a survey to the members of a Discord server
            needs the Discord Integration plugin enabled with a server connected.
          </p>
        )}
      </div>
      )}

      <h2>Questions</h2>
      {questions.map((question, index) => (
        <QuestionEditor
          key={question.id ?? `new-${index}`}
          question={question}
          conditionalEnabled={!!plugins.conditional}
          // Only saved single-choice and true/false questions before this one
          // can control its visibility.
          priorQuestions={questions
            .slice(0, index)
            .filter((q) => q.id && (q.type === 'single_choice' || q.type === 'boolean'))}
          onChange={(fields) =>
            editQuestions((prev) => prev.map((q, i) => (i === index ? { ...q, ...fields } : q)))
          }
          onRemove={() => editQuestions((prev) => prev.filter((_, i) => i !== index))}
          onMove={(delta) =>
            editQuestions((prev) => {
              const to = index + delta;
              if (to < 0 || to >= prev.length) return prev;
              const next = [...prev];
              [next[index], next[to]] = [next[to], next[index]];
              return next;
            })
          }
        />
      ))}

      <div className="savebar">
        <button
          type="button"
          disabled={busy}
          onClick={() =>
            editQuestions((prev) => [
              ...prev,
              { type: 'single_choice', prompt: '', required: true, config: {}, options: [] },
            ])
          }
        >
          Add question
        </button>

        <button type="button" className="primary" onClick={() => save(false)} disabled={busy}>
          {busy ? 'Saving...' : 'Save'}
        </button>

        {/* Feedback sits with the button that caused it, not at the top of a
            page the user has scrolled away from. */}
        {saved ? <span className="save-ok">Saved</span> : null}
        {!saved && dirty && !busy ? (
          <span className="save-dirty">Unsaved changes</span>
        ) : null}
      </div>

      {pendingLoss !== null ? (
        <div className="confirm">
          <h3>Are you absolutely certain?</h3>
          <p>
            Saving these changes deletes {pendingLoss} existing answer
            {pendingLoss === 1 ? '' : 's'}, because you removed a question people had already
            answered. This cannot be undone.
          </p>
          <div className="row">
            <button type="button" onClick={() => setPendingLoss(null)}>
              Cancel
            </button>
            <button type="button" className="danger" onClick={() => save(true)}>
              Save and discard {pendingLoss} answer{pendingLoss === 1 ? '' : 's'}
            </button>
          </div>
        </div>
      ) : null}

      {can('surveys.delete') ? (
        <div className="card" style={{ marginTop: '2rem' }}>
          <h2>Delete survey</h2>
          <p className="muted">
            Removes this survey along with every question and response. There is no undo.
          </p>
          {confirmDelete ? (
            <div className="confirm">
              <h3>Are you absolutely certain?</h3>
              <p>
                All data from this survey will be removed completely, including all metrics!
                {responses?.started
                  ? ` ${responses.started} response${responses.started === 1 ? '' : 's'} will be destroyed.`
                  : ''}{' '}
                This cannot be undone.
              </p>
              <div className="row">
                <button type="button" onClick={() => setConfirmDelete(false)}>
                  Cancel
                </button>
                <button type="button" className="danger" onClick={destroy} disabled={busy}>
                  Delete &ldquo;{survey.title}&rdquo; permanently
                </button>
              </div>
            </div>
          ) : (
            <button type="button" className="danger" onClick={() => setConfirmDelete(true)}>
              Delete survey
            </button>
          )}
        </div>
      ) : null}

      {/* Anonymising is only meaningful once there is something to detach. */}
      {responses && responses.identified > 0 ? (
        <div className="card" style={{ marginTop: '2rem' }}>
          <h2>Anonymise responses</h2>
          <p className="muted">
            Permanently detaches all {responses.started} response
            {responses.started === 1 ? '' : 's'} from whoever submitted them. Answers are kept, but
            nobody can ever work out who gave them, including you. This cannot be undone.
          </p>
          {confirmAnonymise ? (
            <div className="confirm">
              <h3>Are you absolutely certain?</h3>
              <p>
                {responses.identified} recorded username
                {responses.identified === 1 ? '' : 's'} will be erased and cannot be recovered.
              </p>
              <div className="row">
                <button type="button" onClick={() => setConfirmAnonymise(false)}>
                  Cancel
                </button>
                <button type="button" className="danger" onClick={anonymise}>
                  Anonymise permanently
                </button>
              </div>
            </div>
          ) : (
            <button type="button" className="danger" onClick={() => setConfirmAnonymise(true)}>
              Anonymise permanently
            </button>
          )}
        </div>
      ) : null}
    </div>
  );
}
