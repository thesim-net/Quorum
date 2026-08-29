import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { TotpQr } from '../components/TotpQr.jsx';
import { Toggle } from '../components/Toggle.jsx';

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
 * The signed-in admin's own Discord identity.
 *
 * Every admin is expected to hold both identities, so an unlinked account gets
 * the link button here as well as in the forced step. Unlinking is allowed, and
 * the step simply applies again afterwards; the server refuses it outright when
 * it would leave the account with no way to sign in.
 *
 * @param {{discordId: string|null}} props
 * @returns {JSX.Element} The section.
 */
function DiscordIdentity({ discordId }) {
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  /** Drops the linked Discord identity. */
  const unlink = async () => {
    setBusy(true);
    setError(null);
    try {
      await api('/auth/discord/unlink', { method: 'POST' });
      // A full reload, so the panel is never left running behind a step the
      // unlink has just brought back.
      window.location.href = '/admin/settings';
    } catch (e) {
      setError(e.message);
      setBusy(false);
    }
  };

  return (
    <div style={{ marginTop: '1.25rem' }}>
      <h3>Discord account</h3>
      {error ? <div className="error">{error}</div> : null}

      {discordId ? (
        <>
          <p className="muted">
            Linked to Discord id <strong>{discordId}</strong>. Signing in either way reaches this
            same account.
          </p>
          <p className="muted" style={{ fontSize: '0.82rem' }}>
            Unlinking asks you to link again on your next request, and any access granted by a
            Discord role or channel ends with the link.
          </p>
          <button type="button" className="danger" disabled={busy} onClick={unlink}>
            {busy ? 'Unlinking...' : 'Unlink Discord'}
          </button>
        </>
      ) : (
        <>
          <p className="muted">
            Not linked yet. Linking puts your Discord identity on this account, so signing in with
            Discord reaches it instead of creating a second one.
          </p>
          <a className="button" href="/api/auth/discord/link">
            Link Discord
          </a>
        </>
      )}
    </div>
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
 * The automatic update schedule, super admins only.
 *
 * @returns {JSX.Element|null} The card, or null before the state loads.
 */
function AutoUpdate() {
  const [state, setState] = useState(null);
  const [form, setForm] = useState(null);
  const [error, setError] = useState(null);
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState(false);
  const [restarting, setRestarting] = useState(null);
  const pollRef = useRef(null);

  // The poll outlives the click that started it.
  useEffect(() => () => clearInterval(pollRef.current), []);

  const load = () =>
    api('/admin/update/auto')
      .then((data) => {
        setState(data);
        setForm({
          enabled: data.enabled,
          restart: data.restart,
          days: String(data.days ?? 0),
          hours: String(data.hours ?? 0),
          seconds: String(data.seconds ?? 0),
        });
      })
      .catch(() => setState(null));

  useEffect(() => {
    load();
  }, []);

  /** Saves the schedule, surfacing the server's refusal rather than repeating it. */
  const save = async (next) => {
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      await api('/admin/update/auto', { method: 'PUT', body: next });
      await load();
      setStatus('Schedule saved.');
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  /**
   * Waits for the new version to answer, then reloads. Polled rather than
   * reloaded blindly, since a container still coming up serves an error page.
   */
  const watchForRestart = (version) => {
    setRestarting(version);
    pollRef.current = setInterval(() => {
      api('/version')
        .then((v) => {
          if (v.version && v.version === version) window.location.reload();
        })
        .catch(() => {});
    }, 3000);
  };

  /** Restarts into a version already downloaded. */
  const applyNow = async () => {
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      const result = await api('/admin/update/apply', { method: 'POST' });
      if (result.status !== 'restarting') {
        // Every refusal the API can give, in words. Most carry a message; the
        // ones that cannot were surfacing a raw status string.
        setError(
          result.message ??
            {
              'nothing-staged': 'There is no downloaded version waiting to be applied.',
              'not-newer': 'The downloaded version is not newer than the one running.',
              'not-downloaded': 'That version is not on this host yet. Download it first.',
            }[result.status] ??
            `Could not restart: ${result.status}.`,
        );
        return;
      }
      watchForRestart(result.version);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  /** Downloads now, outside the schedule. */
  const download = async () => {
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      const result = await api('/admin/update/download', { method: 'POST' });
      await load();

      // With auto-restart on the server restarts as part of the same call, so
      // say which of the two happened rather than always asking for a restart.
      if (result.status === 'downloaded' && result.applied) {
        if (result.applied.status === 'restarting') return watchForRestart(result.version);
        setError(result.applied.message ?? 'Downloaded, but the restart did not start.');
        return;
      }

      setStatus(
        {
          downloaded: `Version ${result.version} downloaded. Restart to apply it.`,
          current: 'Already running the newest version.',
          unavailable: result.message,
          failed: result.message,
        }[result.status] ?? 'Nothing to do.',
      );
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  if (!state || !form) return null;

  const submit = () =>
    save({
      enabled: form.enabled,
      restart: form.restart,
      days: form.days,
      hours: form.hours,
      seconds: form.seconds,
    });

  return (
    <div className="card">
      <h2>Automatic updates</h2>
      {error ? <div className="error">{error}</div> : null}
      {status ? <p className="muted">{status}</p> : null}

      {restarting ? (
        <p className="muted">
          Quorum is restarting into {restarting}. This page reloads once it answers again.
        </p>
      ) : null}

      {state.stagedVersion && !restarting ? (
        <div className="row" style={{ gap: '0.6rem', marginBottom: '0.8rem' }}>
          <span>
            <strong>Quorum {state.stagedVersion} is downloaded</strong> and waiting on this host.
            <br />
            <span className="muted" style={{ fontSize: '0.82rem' }}>
              Restarting interrupts anyone part-way through a survey, and runs migrations on the
              way back up.
            </span>
          </span>
          <span style={{ marginLeft: 'auto' }} />
          <button type="button" className="primary" disabled={busy} onClick={applyNow}>
            Upgrade and restart Quorum
          </button>
        </div>
      ) : null}

      {!state.dockerAvailable ? (
        <div className="error">
          {state.dockerReason === 'denied' ? (
            <>
              The Docker socket is mounted but Quorum is not allowed to use it. The API runs as a
              non-root user, so it also needs the socket&apos;s group: add{' '}
              <code>group_add: [&quot;&lt;docker gid&gt;&quot;]</code> to the api service, from{' '}
              <code>getent group docker</code> on the host.
            </>
          ) : (
            <>
              Quorum cannot reach the Docker socket, so it cannot download or install updates by
              itself. Mount <code>/var/run/docker.sock</code> into the API container, and give it
              the socket&apos;s group with <code>group_add</code>.
            </>
          )}
        </div>
      ) : null}

      <Toggle
        checked={form.enabled}
        onChange={(enabled) => setForm({ ...form, enabled })}
        label="Automatically upgrade Quorum"
        hint="Checks for a new release on a schedule and downloads it."
      />

      {form.enabled ? (
        <>
          <p className="muted" style={{ fontSize: '0.85rem', marginBottom: '0.4rem' }}>
            How often to check. A new version appears a few times a year, so Quorum will not check
            more than twice a day however this is filled in.
          </p>

          <div className="row" style={{ gap: '0.75rem', flexWrap: 'wrap' }}>
            {['days', 'hours', 'seconds'].map((unit) => (
              <label key={unit}>
                <span className="field-label">{unit[0].toUpperCase() + unit.slice(1)}</span>
                <input
                  type="number"
                  min="0"
                  style={{ width: '6rem' }}
                  value={form[unit]}
                  onChange={(e) => setForm({ ...form, [unit]: e.target.value })}
                />
              </label>
            ))}
          </div>

          <div style={{ marginTop: '0.8rem' }}>
            <Toggle
              checked={form.restart}
              onChange={(restart) => setForm({ ...form, restart })}
              label="Auto-restart Quorum after update"
              hint={
                form.restart
                  ? 'Quorum will restart itself into the new version. In-progress responses are interrupted and migrations run on the way back up.'
                  : 'The update is downloaded and left ready. Nothing restarts until you ask it to.'
              }
            />
          </div>

          {form.restart && !state.composeConfigured ? (
            <div className="error">
              Restarting also needs <code>QUORUM_COMPOSE_DIR</code> set to the mounted compose
              project. Without it Quorum can download an update but not apply one.
            </div>
          ) : null}
        </>
      ) : null}

      <div className="row" style={{ marginTop: '0.9rem' }}>
        <button type="button" className="primary" disabled={busy} onClick={submit}>
          {busy ? 'Saving...' : 'Save schedule'}
        </button>
        <button type="button" disabled={busy || !state.dockerAvailable} onClick={download}>
          Check and download now
        </button>
        <span className="muted" style={{ fontSize: '0.82rem' }}>
          {state.enabled ? `Checking ${state.cadence}.` : 'Not checking automatically.'}
        </span>
      </div>

      {state.lastError ? (
        <p className="muted" style={{ fontSize: '0.82rem' }}>
          Last attempt: {state.lastError}
        </p>
      ) : null}
    </div>
  );
}

/**
 * Settings tab: your own account, two-factor, sign-in methods, automatic
 * updates, Discord, and appearance. Managing other admins, groups, and plugins
 * live in their own tabs.
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
        {plugins.discord ? <DiscordIdentity discordId={account?.discordId ?? null} /> : null}
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

      {me.isSuperAdmin ? <AutoUpdate /> : null}

      {me.isSuperAdmin ? (
        <AsciiAnimationDefault value={asciiDefault} onChange={setAsciiDefault} />
      ) : null}
    </div>
  );
}
