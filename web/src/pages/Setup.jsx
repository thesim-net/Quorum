import { useEffect, useState } from 'react';
import { api } from '../api.js';

/**
 * One labelled credential input.
 *
 * Defined at module scope rather than inside the wizard: a component declared
 * during render is a fresh type on every keystroke, which remounts the input
 * and drops the caret.
 *
 * @param {{label: string, value: string, onChange: (v: string) => void,
 *   hint?: string, type?: string, disabled?: boolean}} props
 * @returns {JSX.Element} The field.
 */
function Field({ label, value, onChange, hint, type = 'text', disabled = false }) {
  return (
    <label>
      <span className="field-label">{label}</span>
      <input
        type={type}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        autoComplete="off"
        spellCheck={false}
      />
      {hint ? (
        <span className="muted" style={{ fontSize: '0.82rem' }}>
          {hint}
        </span>
      ) : null}
    </label>
  );
}

/**
 * Discord connection wizard.
 *
 * Runs in two situations: the first boot, authorised by the one-time token
 * printed in the container logs, and any later re-run by an existing admin.
 * Credentials are verified against Discord before they are allowed to persist.
 *
 * @param {{onDone?: () => void, embedded?: boolean}} props
 *   `embedded` renders it inside the admin panel rather than as a full page.
 * @returns {JSX.Element} The wizard.
 */
export function Setup({ onDone, embedded = false }) {
  const [ready, setReady] = useState(false);
  const [authorised, setAuthorised] = useState(false);
  const [readOnly, setReadOnly] = useState(false);
  const [values, setValues] = useState({
    clientId: '',
    clientSecret: '',
    botToken: '',
    guildId: '',
  });
  const [adminRoleIds, setAdminRoleIds] = useState([]);
  const [adminChannelIds, setAdminChannelIds] = useState([]);
  const [tested, setTested] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [saved, setSaved] = useState(null);
  // Already-connected state: the guild's roles/channels and whether the
  // credentials have been touched. When connected and untouched, admin-access
  // changes can be saved without a separate Test step.
  const [configured, setConfigured] = useState(false);
  const [guildName, setGuildName] = useState(null);
  const [meta, setMeta] = useState({ roles: [], channels: [] });
  const [credsDirty, setCredsDirty] = useState(false);

  useEffect(() => {
    /** Redeems a token from the URL, then loads any existing configuration. */
    const start = async () => {
      const token = new URLSearchParams(window.location.search).get('token');
      if (token) {
        try {
          await api('/setup/token', { method: 'POST', body: { token } });
          // Keep the token out of the address bar and out of browser history.
          window.history.replaceState({}, '', window.location.pathname);
        } catch {
          setError('That setup link is invalid or has expired. Restart the container for a new one.');
          setReady(true);
          return;
        }
      }

      try {
        const data = await api('/setup/current');
        setAuthorised(true);
        setReadOnly(data.readOnly);
        setConfigured(data.configured);
        setMeta({ roles: data.roles ?? [], channels: data.channels ?? [] });
        setGuildName(data.guild?.name ?? null);
        if (data.values) {
          setValues({
            clientId: data.values.clientId ?? '',
            clientSecret: data.values.clientSecret ?? '',
            botToken: data.values.botToken ?? '',
            guildId: data.values.guildId ?? '',
          });
          setAdminRoleIds(data.values.adminRoleIds ?? []);
          setAdminChannelIds(data.values.adminChannelIds ?? []);
        }
      } catch {
        setAuthorised(false);
      }
      setReady(true);
    };
    start();
  }, []);

  /**
   * Updates one field and drops any stale test result.
   *
   * @param {string} field
   * @param {string} value
   */
  const set = (field, value) => {
    // Editing any credential field means the connection must be tested again
    // before it can be saved.
    setCredsDirty(true);
    setValues((prev) => ({ ...prev, [field]: value }));
    setTested(null);
    setSaved(null);
  };

  /** Verifies the credentials against Discord without saving. */
  const test = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await api('/setup/test', { method: 'POST', body: values });
      setTested(result);
      if (!result.ok) setError(result.problems[0]);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  /** Persists the verified credentials. */
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await api('/setup/save', {
        method: 'POST',
        body: { ...values, adminRoleIds, adminChannelIds },
      });
      setSaved(result);
      if (!result.claimUrl && onDone) onDone();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  if (!ready) return <div className={embedded ? '' : 'shell'}>Loading...</div>;

  if (!authorised) {
    return (
      <div className={embedded ? '' : 'shell'}>
        <div className="card">
          <h1>Setup</h1>
          {error ? <div className="error">{error}</div> : null}
          <p className="muted">
            Setup needs the one-time link printed in the container logs. Find it with:
          </p>
          <pre className="codeblock">docker compose logs api | grep setup</pre>
        </div>
      </div>
    );
  }

  // Credentials saved on a first run: the operator becomes admin by signing in.
  if (saved?.claimUrl) {
    return (
      <div className={embedded ? '' : 'shell'}>
        <div className="card">
          <h1>Connected to {saved.guild.name}</h1>
          <p>
            Sign in with Discord to finish. The account you use becomes the first admin.
          </p>
          {saved.warnings?.length ? (
            <div className="error">{saved.warnings.join(' ')}</div>
          ) : null}
          <a className="button primary" href={saved.claimUrl}>
            Sign in with Discord
          </a>
        </div>
      </div>
    );
  }

  return (
    <div className={embedded ? '' : 'shell'}>
      {embedded ? null : <h1>Connect your Discord server</h1>}

      {readOnly ? (
        <div className="disclosure">
          <h3>Managed by the environment</h3>
          <p className="muted" style={{ margin: 0 }}>
            Discord is configured through <code>DISCORD_*</code> environment variables, so it
            cannot be changed here. Remove them from the environment to manage it from this panel
            instead.
          </p>
        </div>
      ) : (
        <div className="disclosure">
          <h3>What you need</h3>
          <ol style={{ margin: 0, paddingLeft: '1.15rem' }}>
            <li>
              Create an application at{' '}
              <a href="https://discord.com/developers/applications" target="_blank" rel="noreferrer">
                discord.com/developers/applications
              </a>
              .
            </li>
            <li>
              Under OAuth2, add a redirect URL of{' '}
              <code>{window.location.origin}/api/auth/callback</code>.
            </li>
            <li>Create a bot for it, and invite the bot to your server with View Channels.</li>
            <li>
              Enable Developer Mode in Discord, then right-click your server and Copy Server ID.
            </li>
          </ol>
        </div>
      )}

      {error ? <div className="error">{error}</div> : null}

      <div className="card">
        <Field
          label="Client ID"
          value={values.clientId}
          onChange={(v) => set('clientId', v)}
          disabled={readOnly}
          hint="OAuth2 tab of your Discord application."
        />
        <Field
          label="Client secret"
          value={values.clientSecret}
          onChange={(v) => set('clientSecret', v)}
          disabled={readOnly}
          type="password"
          hint={values.clientSecret.startsWith('****') ? 'Leave as-is to keep the stored secret.' : ''}
        />
        <Field
          label="Bot token"
          value={values.botToken}
          onChange={(v) => set('botToken', v)}
          disabled={readOnly}
          type="password"
          hint={values.botToken.startsWith('****') ? 'Leave as-is to keep the stored token.' : ''}
        />
        <Field
          label="Server ID"
          value={values.guildId}
          onChange={(v) => set('guildId', v)}
          disabled={readOnly}
          hint="Right-click your server, Copy Server ID."
        />

        {readOnly ? null : (
          <div className="row">
            <button type="button" onClick={test} disabled={busy}>
              {busy ? 'Checking...' : 'Test connection'}
            </button>
            {/* Already connected and credentials untouched: admin-access
                changes save straight away, no separate Test needed. */}
            <button
              type="button"
              className="primary"
              onClick={save}
              disabled={busy || !(tested?.ok || (configured && !credsDirty))}
            >
              Save
            </button>
            {!(tested?.ok || (configured && !credsDirty)) ? (
              <span className="muted" style={{ fontSize: '0.82rem' }}>
                Test the connection before saving.
              </span>
            ) : null}
          </div>
        )}
      </div>

      {/* Admin-access selectors. Shown after a successful test, and also when
          already connected (using the stored guild's roles and channels) so
          they can be changed without re-testing. */}
      {(() => {
        const showAccess = tested?.ok || (configured && !credsDirty);
        if (!showAccess) return null;

        const roles = tested?.ok ? tested.roles : meta.roles;
        const channels = tested?.ok ? tested.channels ?? [] : meta.channels;
        const heading = tested?.ok ? `Connected to ${tested.guild.name}` : `Connected to ${guildName}`;

        return (
          <div className="card">
            <h2>{heading}</h2>
            {tested?.ok ? (
              <p className="muted">
                Signed in as bot <strong>{tested.botUsername}</strong> · {tested.roleCount} roles ·{' '}
                {tested.channelCount} channels
              </p>
            ) : null}

            {tested?.problems?.length ? (
              <div className="error">{tested.problems.join(' ')}</div>
            ) : null}

            <label>
              <span className="field-label">Roles that grant admin access (optional)</span>
              <select
                multiple
                size={Math.min(8, Math.max(3, roles.length))}
                value={adminRoleIds}
                onChange={(e) => setAdminRoleIds([...e.target.selectedOptions].map((o) => o.value))}
              >
                {roles.map((role) => (
                  <option key={role.id} value={role.id}>
                    {role.name}
                  </option>
                ))}
              </select>
            </label>

            <label>
              <span className="field-label">Channels that grant admin access (optional)</span>
              <select
                multiple
                size={Math.min(8, Math.max(3, channels.length))}
                value={adminChannelIds}
                onChange={(e) =>
                  setAdminChannelIds([...e.target.selectedOptions].map((o) => o.value))
                }
              >
                {channels.map((channel) => (
                  <option key={channel.id} value={channel.id}>
                    #{channel.name}
                  </option>
                ))}
              </select>
            </label>

            <p className="muted" style={{ fontSize: '0.82rem' }}>
              Anyone with one of these roles, or who can see one of these channels, gets admin access
              with every permission. They do <strong>not</strong> become super administrators.
            </p>
          </div>
        );
      })()}

      {saved && !saved.claimUrl ? <p className="muted">Saved.</p> : null}
    </div>
  );
}
