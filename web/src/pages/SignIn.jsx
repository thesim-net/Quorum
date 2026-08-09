import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { TotpQr } from '../components/TotpQr.jsx';

const OAUTH_ERRORS = {
  not_in_guild: 'That Discord account is not a member of our server.',
  invalid_state: 'Sign-in expired. Please try again.',
  discord_unavailable: 'Discord sign-in is not available right now.',
  // A Discord account nobody has claimed signs in as nobody. It is never turned
  // into a new, empty account, so the way forward is to sign in to the real one
  // and attach Discord to it.
  discord_unlinked:
    'This Discord account is not linked to a Quorum account. Sign in with your username and ' +
    'password, then link Discord from Settings.',
  link_signed_out: 'Your session ended before linking finished. Sign in, then link from Settings.',
};

/**
 * Two-factor code entry, shown after a successful password or Discord sign-in
 * on an account under 2FA.
 *
 * An account required to use 2FA that has not enrolled yet is walked through
 * enrolment right here: the server hands back the QR and secret inside the
 * challenge, and the first valid code completes both enrolment and sign-in.
 *
 * @returns {JSX.Element} The code step.
 */
function TwoFactorStep() {
  const [enrolment, setEnrolment] = useState(null);
  const [ready, setReady] = useState(false);
  const [code, setCode] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api('/auth/2fa/begin', { method: 'POST' })
      .then((data) => {
        if (!data.enrolled) setEnrolment({ secret: data.secret, otpauth: data.otpauth });
        setReady(true);
      })
      .catch((e) => {
        setError(e.message);
        setReady(true);
      });
  }, []);

  /** Submits the one-time code and finishes the sign-in. */
  const submit = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('/auth/2fa', { method: 'POST', body: { code } });
      window.location.href = '/';
    } catch (e) {
      setError(e.message);
      setBusy(false);
    }
  };

  if (!ready) return <p className="muted">Loading...</p>;

  return (
    <form onSubmit={submit}>
      {enrolment ? (
        <>
          <p className="muted">
            Your account requires two-factor authentication, which has not been set up yet.
          </p>
          <TotpQr otpauth={enrolment.otpauth} secret={enrolment.secret} />
        </>
      ) : (
        <p className="muted">Enter the six-digit code from your authenticator app.</p>
      )}

      {error ? <div className="error">{error}</div> : null}

      <label>
        <span className="field-label">Authentication code</span>
        <input
          type="text"
          inputMode="numeric"
          autoComplete="one-time-code"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          autoFocus
        />
      </label>
      <button type="submit" className="primary" disabled={busy || !code.trim()}>
        {busy ? 'Checking...' : 'Verify'}
      </button>
    </form>
  );
}

/**
 * The sign-in page.
 *
 * Offers whichever methods the deployment has enabled: a username/password
 * form, a Discord button, or both. Participants never need this page; taking
 * a survey works signed out.
 *
 * @param {{devAuthBypass: boolean}} props
 * @returns {JSX.Element} The page.
 */
export function SignIn({ devAuthBypass }) {
  const params = new URLSearchParams(window.location.search);
  const oauthError = params.get('error');

  const [methods, setMethods] = useState(null);
  const [twofactor, setTwofactor] = useState(params.get('twofactor') === '1');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api('/auth/methods')
      .then((data) => setMethods(data.methods))
      .catch(() => setMethods({ local: true, discord: false }));
  }, []);

  /** Signs in with the local username and password. */
  const login = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await api('/auth/login', { method: 'POST', body: { username, password } });
      if (result.twofactor) {
        setTwofactor(true);
        setBusy(false);
      } else {
        window.location.href = '/';
      }
    } catch (e) {
      setError(e.message);
      setBusy(false);
    }
  };

  /**
   * Signs in without an account. Only reachable in local preview.
   *
   * @param {boolean} admin Whether to sign in as an admin.
   */
  const devLogin = async (admin) => {
    await api('/auth/dev-login', {
      method: 'POST',
      body: { admin, username: admin ? 'previewadmin' : 'previewmember' },
    });
    window.location.href = '/';
  };

  if (twofactor) {
    return (
      <div className="shell">
        <div className="card">
          <h1>Two-factor authentication</h1>
          <TwoFactorStep />
        </div>
      </div>
    );
  }

  return (
    <div className="shell">
      <div className="card">
        <h1>Sign in</h1>
        <p className="muted">
          Signing in is for administrators{methods?.discord ? ' and for surveys restricted to our Discord server' : ''}.
          Open surveys can be taken without an account.
        </p>

        {oauthError ? <div className="error">{OAUTH_ERRORS[oauthError] ?? 'Sign-in failed.'}</div> : null}
        {error ? <div className="error">{error}</div> : null}

        {!methods ? <p className="muted">Loading...</p> : null}

        {methods?.local ? (
          <form onSubmit={login}>
            <label>
              <span className="field-label">Username</span>
              <input
                type="text"
                value={username}
                autoComplete="username"
                onChange={(e) => setUsername(e.target.value)}
              />
            </label>
            <label>
              <span className="field-label">Password</span>
              <input
                type="password"
                value={password}
                autoComplete="current-password"
                onChange={(e) => setPassword(e.target.value)}
              />
            </label>
            <button type="submit" className="primary" disabled={busy || !username.trim() || !password}>
              {busy ? 'Signing in...' : 'Sign in'}
            </button>
          </form>
        ) : null}

        {methods?.local && methods?.discord ? (
          <p className="muted" style={{ margin: '1rem 0 0.5rem' }}>
            or
          </p>
        ) : null}

        {methods?.discord ? (
          <a className="button primary" href="/api/auth/discord/login">
            Continue with Discord
          </a>
        ) : null}

        {methods && !methods.local && !methods.discord ? (
          <p className="muted">No sign-in method is enabled on this deployment.</p>
        ) : null}

        <p style={{ marginTop: '1.25rem', marginBottom: 0 }}>
          <Link to="/">Back to surveys</Link>
        </p>

        {devAuthBypass ? (
          <div className="disclosure" style={{ marginTop: '1.5rem' }}>
            <h3>Local preview mode</h3>
            <p className="muted" style={{ margin: '0 0 0.75rem' }}>
              Sign-in is bypassed because <code>DEV_AUTH_BYPASS</code> is set. This is never
              available on a real deployment.
            </p>
            <div className="row">
              <button type="button" onClick={() => devLogin(true)}>
                Sign in as admin
              </button>
              <button type="button" onClick={() => devLogin(false)}>
                Sign in as member
              </button>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
