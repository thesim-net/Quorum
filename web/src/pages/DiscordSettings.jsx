import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
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
 * Discord plugin settings: the server connection wizard.
 *
 * Super admins connect or reconnect the Discord server here. Credentials are
 * verified against Discord before they are allowed to persist, and the page
 * works whether or not the plugin is currently enabled so a server can be
 * connected before switching it on.
 *
 * @returns {JSX.Element} The page.
 */
export function DiscordSettings() {
  const [ready, setReady] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [readOnly, setReadOnly] = useState(false);
  const [values, setValues] = useState({
    clientId: '',
    clientSecret: '',
    botToken: '',
    guildId: '',
  });
  const [adminRoleIds, setAdminRoleIds] = useState([]);
  const [adminChannelIds, setAdminChannelIds] = useState([]);
  // Which group an account granted by one of those roles or channels resolves
  // against. Nobody creates those accounts, so nobody would otherwise pick a
  // group for them, and there is no default group left to fall back on.
  const [adminGroupId, setAdminGroupId] = useState('');
  const [groups, setGroups] = useState([]);
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
    api('/plugin/discord/settings')
      .then((data) => {
        setEnabled(data.enabled);
        setReadOnly(data.readOnly);
        setConfigured(data.configured);
        setMeta({ roles: data.roles ?? [], channels: data.channels ?? [] });
        setGuildName(data.guild?.name ?? null);
        setGroups(data.groups ?? []);
        setAdminGroupId(data.adminGroupId ?? '');
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
        if (data.error === 'unreadable') {
          setError(
            'Stored Discord credentials could not be decrypted. This happens when ' +
              'SESSION_SECRET changes. Enter the credentials again to reconnect.',
          );
        }
      })
      .catch((e) => setError(e.message))
      .finally(() => setReady(true));
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
      const result = await api('/plugin/discord/settings/test', { method: 'POST', body: values });
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
      const result = await api('/plugin/discord/settings', {
        method: 'POST',
        body: { ...values, adminRoleIds, adminChannelIds, adminGroupId: adminGroupId || null },
      });
      setSaved(result);
      setConfigured(true);
      setGuildName(result.guild?.name ?? guildName);
      setCredsDirty(false);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  if (!ready) return <div className="shell">Loading...</div>;

  return (
    <div className="shell">
      <p>
        <Link to="/admin/plugins">Back to plugins</Link>
      </p>
      <h1>Discord Integration</h1>

      {enabled ? null : (
        <div className="disclosure">
          <h3>Plugin disabled</h3>
          <p className="muted" style={{ margin: 0 }}>
            The Discord Integration plugin is currently disabled. The connection can be set up
            here, but Discord sign-in and survey gates stay off until the plugin is enabled on
            the <Link to="/admin/plugins">plugins page</Link>.
          </p>
        </div>
      )}

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

            {/* Nobody creates these accounts: the tier is resolved per request
                from the role or channel, so nobody ever picks a group for them
                either. There is no default group to fall back on, so this is
                where they get one - or they get nothing. */}
            <label>
              <span className="field-label">Group these admins belong to</span>
              <select
                value={adminGroupId}
                onChange={(e) => setAdminGroupId(e.target.value)}
                style={{ minWidth: '12rem' }}
              >
                <option value="">No group - they get no access</option>
                {groups.map((group) => (
                  <option key={group.id} value={group.id}>
                    {group.name}
                  </option>
                ))}
              </select>
            </label>

            <p className="muted" style={{ fontSize: '0.82rem' }}>
              Anyone with one of these roles, or who can see one of these channels, gets the
              administrator tier. They do <strong>not</strong> become super administrators. What
              they can actually do comes from the group above, exactly as it does for anybody else.
            </p>
            {/* Only worth saying once a role or channel actually grants
                something: with both lists empty there is nobody to strand. */}
            {!adminGroupId && (adminRoleIds.length > 0 || adminChannelIds.length > 0) ? (
              <div className="error">
                No group is chosen, so anyone granted admin by these roles or channels reaches the
                panel and can do nothing in it. Pick a group above, or clear the lists.
              </div>
            ) : null}
          </div>
        );
      })()}

      {saved ? <p className="muted">Saved.</p> : null}
    </div>
  );
}
