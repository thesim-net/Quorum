import { useEffect, useState } from 'react';
import { api } from '../api.js';

/**
 * First-run setup: creates the first super administrator.
 *
 * Authorised by the one-time token printed in the container logs. Connecting a
 * Discord server is no longer part of setup; that lives in the Discord
 * plugin's settings once this account signs in.
 *
 * @returns {JSX.Element} The setup form.
 */
export function Setup() {
  const [ready, setReady] = useState(false);
  const [authorised, setAuthorised] = useState(false);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    /** Redeems the token from the URL into a short-lived setup cookie. */
    const start = async () => {
      const token = new URLSearchParams(window.location.search).get('token');
      if (!token) {
        setReady(true);
        return;
      }

      try {
        await api('/setup/token', { method: 'POST', body: { token } });
        // Keep the token out of the address bar and out of browser history.
        window.history.replaceState({}, '', window.location.pathname);
        setAuthorised(true);
      } catch {
        setError('That setup link is invalid or has expired. Restart the container for a new one.');
      }
      setReady(true);
    };
    start();
  }, []);

  /** Creates the first super admin and signs them in. */
  const submit = async (event) => {
    event.preventDefault();
    if (password !== confirm) {
      setError('The passwords do not match.');
      return;
    }

    setBusy(true);
    setError(null);
    try {
      await api('/setup/bootstrap', { method: 'POST', body: { username, password } });
      // Signed in as the new super admin; land on the admin panel.
      window.location.href = '/admin';
    } catch (e) {
      setError(e.message);
      setBusy(false);
    }
  };

  if (!ready) return <div className="shell">Loading...</div>;

  if (!authorised) {
    return (
      <div className="shell">
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

  return (
    <div className="shell">
      <div className="card">
        <h1>Create the first administrator</h1>
        <p className="muted">
          This account is the super administrator: it manages surveys, other admins, and plugins.
          Sign-in methods, including Discord, are configured afterwards from the admin panel.
        </p>

        {error ? <div className="error">{error}</div> : null}

        <form onSubmit={submit}>
          <label>
            <span className="field-label">Username</span>
            <input
              type="text"
              value={username}
              autoComplete="username"
              spellCheck={false}
              onChange={(e) => setUsername(e.target.value)}
            />
            <span className="muted" style={{ fontSize: '0.82rem' }}>
              3-32 characters: letters, numbers, dots, dashes, underscores.
            </span>
          </label>
          <label>
            <span className="field-label">Password</span>
            <input
              type="password"
              value={password}
              autoComplete="new-password"
              onChange={(e) => setPassword(e.target.value)}
            />
            <span className="muted" style={{ fontSize: '0.82rem' }}>
              At least 8 characters.
            </span>
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
            disabled={busy || !username.trim() || password.length < 8 || !confirm}
          >
            {busy ? 'Creating...' : 'Create account'}
          </button>
        </form>
      </div>
    </div>
  );
}
