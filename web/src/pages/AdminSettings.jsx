import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { TotpQr } from '../components/TotpQr.jsx';

/**
 * Change-password form for the signed-in admin's own local account.
 *
 * @returns {JSX.Element} The form.
 */
function ChangePassword() {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState(null);
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState(false);

  /** Submits the password change. */
  const submit = async (event) => {
    event.preventDefault();
    if (newPassword !== confirm) {
      setError('The new passwords do not match.');
      return;
    }

    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      await api('/auth/password', { method: 'POST', body: { currentPassword, newPassword } });
      setStatus('Password changed.');
      setCurrentPassword('');
      setNewPassword('');
      setConfirm('');
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit}>
      <h3>Change password</h3>
      {error ? <div className="error">{error}</div> : null}
      {status ? <p className="muted">{status}</p> : null}
      <label>
        <span className="field-label">Current password</span>
        <input
          type="password"
          value={currentPassword}
          autoComplete="current-password"
          onChange={(e) => setCurrentPassword(e.target.value)}
        />
      </label>
      <label>
        <span className="field-label">New password (at least 8 characters)</span>
        <input
          type="password"
          value={newPassword}
          autoComplete="new-password"
          onChange={(e) => setNewPassword(e.target.value)}
        />
      </label>
      <label>
        <span className="field-label">Confirm new password</span>
        <input
          type="password"
          value={confirm}
          autoComplete="new-password"
          onChange={(e) => setConfirm(e.target.value)}
        />
      </label>
      <button
        type="submit"
        disabled={busy || !currentPassword || newPassword.length < 8 || !confirm}
      >
        {busy ? 'Saving...' : 'Change password'}
      </button>
    </form>
  );
}

/**
 * Set or change the signed-in admin's local username.
 *
 * Available to everyone, including Discord-authenticated admins, so the local
 * sign-in name can be chosen independently of the password.
 *
 * @param {{current: string|null, onChange: () => void}} props
 * @returns {JSX.Element} The form.
 */
function SetUsername({ current, onChange }) {
  const [username, setUsername] = useState(current ?? '');
  const [error, setError] = useState(null);
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState(false);

  /** Submits the username change. */
  const submit = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      await api('/auth/username', { method: 'POST', body: { username: username.trim() } });
      setStatus('Username saved.');
      onChange?.();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} style={{ marginTop: '1.25rem' }}>
      <h3>{current ? 'Change username' : 'Set username'}</h3>
      {error ? <div className="error">{error}</div> : null}
      {status ? <p className="muted">{status}</p> : null}
      <label>
        <span className="field-label">
          Username (3-32 characters: letters, numbers, dots, dashes, underscores)
        </span>
        <input
          type="text"
          value={username}
          autoComplete="username"
          onChange={(e) => setUsername(e.target.value)}
        />
      </label>
      <button type="submit" disabled={busy || !username.trim() || username.trim() === current}>
        {busy ? 'Saving...' : 'Save username'}
      </button>
    </form>
  );
}

/**
 * The signed-in admin's own two-factor enrolment.
 *
 * Shows a QR code and the plain secret; a first valid code confirms. Removal
 * takes a current code and is refused while 2FA is required for the account.
 *
 * @returns {JSX.Element|null} The section, or null before the status loads.
 */
function TwoFactorAccount() {
  const [state, setState] = useState(null);
  const [enrolment, setEnrolment] = useState(null);
  const [code, setCode] = useState('');
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState(null);
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = () =>
    api('/plugin/twofactor/status')
      .then(setState)
      .catch((e) => setError(e.message));

  useEffect(() => {
    load();
  }, []);

  /** Starts enrolment and shows the QR plus secret. */
  const begin = async () => {
    setBusy(true);
    setError(null);
    try {
      const data = await api('/plugin/twofactor/enroll', { method: 'POST' });
      setEnrolment(data);
      setCode('');
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  /** Confirms enrolment with the first code. */
  const confirm = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('/plugin/twofactor/confirm', { method: 'POST', body: { code } });
      setEnrolment(null);
      setCode('');
      setStatus('Two-factor authentication is on.');
      // Flip the status immediately rather than waiting on the refetch, so the
      // section shows "Enabled" the moment the code is accepted.
      setState((prev) => ({ ...(prev ?? {}), enrolled: true }));
      await load();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  /** Removes the enrolment, confirmed with a current code. */
  const unenroll = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('/plugin/twofactor/unenroll', { method: 'POST', body: { code } });
      setRemoving(false);
      setCode('');
      setStatus('Two-factor authentication removed.');
      setState((prev) => ({ ...(prev ?? {}), enrolled: false }));
      await load();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  if (!state) return null;

  return (
    <div style={{ marginTop: '1.25rem' }}>
      <h3>Two-factor authentication</h3>
      {error ? <div className="error">{error}</div> : null}
      {status ? <p className="muted">{status}</p> : null}

      {state.enrolled ? (
        <>
          <p className="muted">
            Enabled{state.required ? ' and required for this account' : ''}. Signing in asks for a
            code from your authenticator app.
          </p>
          {state.required ? null : removing ? (
            <form onSubmit={unenroll}>
              <label>
                <span className="field-label">Current code</span>
                <input
                  type="text"
                  inputMode="numeric"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                />
              </label>
              <div className="row">
                <button type="button" onClick={() => setRemoving(false)}>
                  Cancel
                </button>
                <button type="submit" className="danger" disabled={busy || !code.trim()}>
                  Remove 2FA
                </button>
              </div>
            </form>
          ) : (
            <button type="button" onClick={() => setRemoving(true)}>
              Remove 2FA
            </button>
          )}
        </>
      ) : enrolment ? (
        <form onSubmit={confirm}>
          <TotpQr otpauth={enrolment.otpauth} secret={enrolment.secret} />
          <label>
            <span className="field-label">Enter the first code to confirm</span>
            <input
              type="text"
              inputMode="numeric"
              value={code}
              onChange={(e) => setCode(e.target.value)}
            />
          </label>
          <button type="submit" className="primary" disabled={busy || !code.trim()}>
            {busy ? 'Checking...' : 'Confirm'}
          </button>
        </form>
      ) : (
        <>
          <p className="muted">
            Not set up{state.required ? ', but required for this account: you will be asked to enrol at your next sign-in' : ''}.
            Codes come from any authenticator app.
          </p>
          <button type="button" onClick={begin} disabled={busy}>
            Set up 2FA
          </button>
        </>
      )}
    </div>
  );
}

/**
 * Deployment-wide two-factor policy, super admins only.
 *
 * When on, every admin must complete 2FA at sign-in regardless of their own
 * setting. It only takes effect while the Two-Factor Authentication plugin is
 * enabled; with the plugin off it is stored but suspended.
 *
 * @returns {JSX.Element|null} The card, or null before the state loads.
 */
function TwoFactorPolicy() {
  const [state, setState] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = () =>
    api('/admin/security')
      .then(setState)
      .catch(() => setState(null));

  useEffect(() => {
    load();
  }, []);

  /** Flips the global requirement. */
  const toggle = async () => {
    setBusy(true);
    setError(null);
    try {
      await api('/admin/security', {
        method: 'PUT',
        body: { require2faAllAdmins: !state.require2faAllAdmins },
      });
      await load();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  if (!state) return null;

  return (
    <div className="card">
      <h2>Two-factor policy</h2>
      {error ? <div className="error">{error}</div> : null}
      <div className="row">
        <span>
          Require two-factor authentication for all administrators
          <br />
          <span className="muted" style={{ fontSize: '0.82rem' }}>
            {state.twofactor
              ? 'Every admin is asked to enrol and enter a code at their next sign-in.'
              : 'Stored, but suspended until the Two-Factor Authentication plugin is enabled.'}
          </span>
        </span>
        <span style={{ marginLeft: 'auto' }} />
        <button type="button" disabled={busy} onClick={toggle}>
          {state.require2faAllAdmins ? 'Turn off' : 'Turn on'}
        </button>
      </div>
    </div>
  );
}

/**
 * Sign-in method toggles, super admins only.
 *
 * The server enforces the guard rails; this just surfaces its refusals.
 *
 * @returns {JSX.Element|null} The card, or null before the state loads.
 */
function AuthMethods() {
  const [state, setState] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = () =>
    api('/admin/auth-methods')
      .then(setState)
      .catch(() => setState(null));

  useEffect(() => {
    load();
  }, []);

  /**
   * Flips one method on or off.
   *
   * @param {string} key `local` or `discord`.
   */
  const toggle = async (key) => {
    setBusy(true);
    setError(null);
    try {
      await api('/admin/auth-methods', {
        method: 'PUT',
        body: { methods: { ...state.methods, [key]: !state.methods[key] } },
      });
      await load();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  if (!state) return null;

  return (
    <div className="card">
      <h2>Sign-in methods</h2>
      {error ? <div className="error">{error}</div> : null}

      <div className="row">
        <span>
          Username &amp; password
          <br />
          <span className="muted" style={{ fontSize: '0.82rem' }}>
            Every admin, including Discord admins, also holds a local username and password as a
            fallback, so this can stay usable even if Discord sign-in is turned off.
          </span>
        </span>
        <span style={{ marginLeft: 'auto' }} />
        <button type="button" disabled={busy} onClick={() => toggle('local')}>
          {state.methods.local ? 'Disable' : 'Enable'}
        </button>
      </div>

      <div className="row" style={{ marginTop: '0.6rem' }}>
        <span>
          Discord
          <br />
          <span className="muted" style={{ fontSize: '0.82rem' }}>
            {state.discordReady
              ? 'Sign in with a Discord account from the connected server.'
              : 'Needs the Discord plugin enabled and connected before it takes effect.'}
          </span>
        </span>
        <span style={{ marginLeft: 'auto' }} />
        <button type="button" disabled={busy} onClick={() => toggle('discord')}>
          {state.methods.discord ? 'Disable' : 'Enable'}
        </button>
      </div>
    </div>
  );
}

/**
 * Deployment default for the animated wordmark, super admins only.
 *
 * Framed for accessibility: the glitch animation is motion that can affect
 * photosensitive viewers. A signed-in user's own preference overrides it.
 *
 * @param {{value: boolean, onChange: (next: boolean) => void}} props
 * @returns {JSX.Element} The card.
 */
function AsciiAnimationDefault({ value, onChange }) {
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  /** Flips the deployment default. */
  const toggle = async () => {
    setBusy(true);
    setError(null);
    try {
      await api('/admin/ascii-animation', { method: 'PUT', body: { enabled: !value } });
      onChange(!value);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card">
      <h2>Appearance</h2>
      {error ? <div className="error">{error}</div> : null}
      <div className="row">
        <span>
          Animate the QUORUM wordmark by default
          <br />
          <span className="muted" style={{ fontSize: '0.82rem' }}>
            The wordmark glitches with motion. Turn this off deployment-wide for photosensitive or
            epilepsy-sensitive viewers. Anyone can still override it by clicking the wordmark, and a
            reduced-motion browser setting is honoured for users with no preference of their own.
          </span>
        </span>
        <span style={{ marginLeft: 'auto' }} />
        <button type="button" disabled={busy} onClick={toggle}>
          {value ? 'Turn off' : 'Turn on'}
        </button>
      </div>
    </div>
  );
}

/**
 * Settings tab: your own account, two-factor, sign-in methods, Discord, and
 * appearance. Managing other admins, groups, and plugins live in their own tabs.
 *
 * @returns {JSX.Element} The page.
 */
export function AdminSettings() {
  const [me, setMe] = useState(null);
  const [account, setAccount] = useState(null);
  const [plugins, setPlugins] = useState({});
  const [discordStatus, setDiscordStatus] = useState(null);
  const [asciiDefault, setAsciiDefault] = useState(true);

  const loadAccount = () =>
    api('/auth/me')
      .then((data) => {
        setAccount(data.user);
        setPlugins(data.plugins ?? {});
        setAsciiDefault(data.asciiAnimationDefault !== false);
      })
      .catch(() => setAccount(null));

  useEffect(() => {
    api('/admin/me').then(setMe).catch(() => setMe(null));
    loadAccount();
  }, []);

  useEffect(() => {
    if (!me?.isSuperAdmin) return;
    api('/plugin/discord/status').then(setDiscordStatus).catch(() => setDiscordStatus(null));
  }, [me]);

  if (!me) return <div className="shell muted">Loading...</div>;

  return (
    <div className="shell">
      <h1>Settings</h1>

      {/* The signed-in admin's own credentials. */}
      <div className="card">
        <h2>Your account</h2>
        <ChangePassword />
        <SetUsername current={account?.username ?? null} onChange={loadAccount} />
        {plugins.twofactor ? <TwoFactorAccount /> : null}
      </div>

      {me.isSuperAdmin && plugins.twofactor ? <TwoFactorPolicy /> : null}

      {me.isSuperAdmin ? <AuthMethods /> : null}

      {me.isSuperAdmin && plugins.discord ? (
        <div className="card">
          <h2>Discord</h2>
          <div className="row">
            <span className="badge">
              {discordStatus?.configured ? discordStatus.guildName ?? 'Connected' : 'Not connected'}
            </span>
            {discordStatus?.source === 'environment' ? (
              <span className="muted" style={{ fontSize: '0.82rem' }}>
                Configured by environment variables.
              </span>
            ) : null}
            <span style={{ marginLeft: 'auto' }} />
            <Link className="button" to="/admin/plugins/discord">
              {discordStatus?.configured ? 'Manage connection' : 'Connect a server'}
            </Link>
          </div>
        </div>
      ) : null}

      {me.isSuperAdmin ? (
        <AsciiAnimationDefault value={asciiDefault} onChange={setAsciiDefault} />
      ) : null}
    </div>
  );
}
