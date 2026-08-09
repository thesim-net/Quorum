import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { AdminUsers } from './AdminUsers.jsx';
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
            Local admin accounts.
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
 * Administration: who has access, your own account, and how sign-in works.
 *
 * Surveys live on their own page; nothing here is about running one.
 *
 * @returns {JSX.Element} The page.
 */
export function AdminSettings() {
  const [me, setMe] = useState(null);
  const [account, setAccount] = useState(null);
  const [plugins, setPlugins] = useState({});
  const [discordStatus, setDiscordStatus] = useState(null);
  const [version, setVersion] = useState('');
  const [update, setUpdate] = useState(null);
  const [showUpdate, setShowUpdate] = useState(false);

  useEffect(() => {
    api('/admin/me').then(setMe).catch(() => setMe(null));
    api('/auth/me')
      .then((data) => {
        setAccount(data.user);
        setPlugins(data.plugins ?? {});
      })
      .catch(() => setAccount(null));
    api('/version').then((v) => setVersion(v.version)).catch(() => setVersion(''));
    // Super-admin only on the server; a 403 for a plain admin just leaves the
    // banner hidden.
    api('/admin/update').then(setUpdate).catch(() => setUpdate(null));
  }, []);

  useEffect(() => {
    if (!me?.isSuperAdmin) return;
    api('/plugin/discord/status').then(setDiscordStatus).catch(() => setDiscordStatus(null));
  }, [me]);

  if (!me) return <div className="shell muted">Loading...</div>;

  return (
    <div className="shell">
      <h1>Admin</h1>

      {update?.updateAvailable ? (
        <div className="update-banner">
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <span>
              <strong>Update available:</strong> Quorum {update.latest} (you have v{version}).
            </span>
            <span className="row" style={{ gap: '0.5rem' }}>
              {update.url ? (
                <a className="button" href={update.url} target="_blank" rel="noreferrer">
                  Release notes
                </a>
              ) : null}
              <button type="button" className="primary" onClick={() => setShowUpdate((v) => !v)}>
                {showUpdate ? 'Hide' : 'Update'}
              </button>
            </span>
          </div>

          {showUpdate ? (
            <div style={{ marginTop: '0.75rem' }}>
              <p className="muted" style={{ marginTop: 0 }}>
                From the folder holding your <code>docker-compose.yml</code>, run:
              </p>
              <pre className="codeblock">./update.sh</pre>
              <p className="muted" style={{ fontSize: '0.82rem', marginBottom: 0 }}>
                This pulls the new images and restarts. Database migrations run automatically when
                the new version starts. Or run it by hand:{' '}
                <code>docker compose pull && docker compose up -d</code>.
              </p>
            </div>
          ) : null}
        </div>
      ) : null}

      {/* Plain admins see a filtered, read-only version; the server decides
          what is in it. */}
      <AdminUsers />

      {/* The signed-in admin's own credentials. */}
      <div className="card">
        <h2>Your account</h2>
        {account?.hasPassword ? <ChangePassword /> : (
          <p className="muted">
            You sign in with Discord, so there is no local password on this account.
          </p>
        )}
        {plugins.twofactor ? <TwoFactorAccount /> : null}
      </div>

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
            <Link className="button" to="/plugins/discord">
              {discordStatus?.configured ? 'Manage connection' : 'Connect a server'}
            </Link>
          </div>
        </div>
      ) : null}

      <div className="card">
        <h2>About</h2>
        <div className="row">
          <span className="muted">Quorum version</span>
          <span className="badge">{version ? `v${version}` : 'unknown'}</span>
          <span style={{ marginLeft: 'auto' }} />
          <Link className="button" to="/plugins">
            Plugins
          </Link>
        </div>
        <p className="muted" style={{ fontSize: '0.82rem', marginTop: '0.6rem' }}>
          Automatic updates and migrations are planned.
        </p>
      </div>
    </div>
  );
}
