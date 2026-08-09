import { useState } from 'react';
import { api } from '../api.js';

/**
 * First step of the finish-setup flow: username and password.
 *
 * Shown before any admin page to an account that can reach the panel but has no
 * local password yet, typically a Discord admin. Setting a local username and
 * password means switching to local-only sign-in can never lock them out. The
 * surrounding flow supplies the page frame and, where Discord applies, the
 * linking step that follows this one.
 *
 * @param {{user: {hasUsername: boolean, username?: string}}} props
 * @returns {JSX.Element} The step.
 */
export function SetCredentials({ user }) {
  const needsUsername = !user?.hasUsername;
  const [username, setUsername] = useState(needsUsername ? '' : user?.username ?? '');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  /** Submits the initial credentials, then reloads into the panel. */
  const submit = async (event) => {
    event.preventDefault();
    if (password !== confirm) {
      setError('The passwords do not match.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api('/auth/password', {
        method: 'POST',
        body: { newPassword: password, username: needsUsername ? username.trim() : undefined },
      });
      // A full reload picks up the refreshed /auth/me, which moves the flow on
      // to whatever is still outstanding, or into the panel when nothing is.
      window.location.href = '/admin';
    } catch (e) {
      setError(e.message);
      setBusy(false);
    }
  };

  return (
    <div className="card">
      <h2>Set your admin username &amp; password</h2>
      <p className="muted">
        This account can reach the admin panel but has no local password yet. Set a username and
        password now so you can still sign in if Discord sign-in is ever turned off. You can change
        them later from Settings.
      </p>

      {error ? <div className="error">{error}</div> : null}

      <form onSubmit={submit}>
        {needsUsername ? (
          <label>
            <span className="field-label">Username</span>
            <input
              type="text"
              value={username}
              autoComplete="username"
              onChange={(e) => setUsername(e.target.value)}
            />
          </label>
        ) : (
          <p className="muted" style={{ fontSize: '0.85rem' }}>
            Signing in as <strong>{user.username}</strong>.
          </p>
        )}
        <label>
          <span className="field-label">Password (at least 8 characters)</span>
          <input
            type="password"
            value={password}
            autoComplete="new-password"
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        <label>
          <span className="field-label">Confirm password</span>
          <input
            type="password"
            value={confirm}
            autoComplete="new-password"
            onChange={(e) => setConfirm(e.target.value)}
          />
        </label>
        <button
          type="submit"
          className="primary"
          disabled={busy || password.length < 8 || !confirm || (needsUsername && !username.trim())}
        >
          {busy ? 'Saving...' : 'Save and continue'}
        </button>
      </form>
    </div>
  );
}
