import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';

// Failures that happen during the OAuth round trip come back on the URL, since
// there is no response body to read from a redirect.
const LINK_ERRORS = {
  not_in_guild: 'That Discord account is not a member of our server.',
  invalid_state: 'Linking expired before it finished. Try again.',
  discord_unavailable: 'Discord is not available right now.',
  link_signed_out: 'Your session ended before linking finished. Sign in, then try again.',
};

/**
 * "Link your Discord account" step.
 *
 * Sends the browser through the same OAuth flow sign-in uses; the intent is
 * carried in the state, so no second redirect URL is involved. Discord returns
 * to this page with `?complete=1`, and the link is finished by a POST from
 * here rather than by the callback itself.
 *
 * @param {{forced?: boolean, onSignOut?: () => void}} props `forced` when this
 *   is the outstanding onboarding step rather than a visit from Settings.
 * @returns {JSX.Element} The step.
 */
export function LinkDiscord({ forced = false, onSignOut }) {
  const params = new URLSearchParams(window.location.search);
  const completing = params.get('complete') === '1';
  const failure = params.get('error');

  const [error, setError] = useState(
    failure ? LINK_ERRORS[failure] ?? 'Linking failed. Try again.' : null,
  );
  const [busy, setBusy] = useState(completing);
  // The POST must fire once even though the effect runs twice under StrictMode.
  const attempted = useRef(false);

  useEffect(() => {
    if (!completing || attempted.current) return;
    attempted.current = true;

    api('/auth/discord/link', { method: 'POST' })
      .then(() => {
        // A full reload picks up the refreshed /auth/me, which lifts the step.
        window.location.href = forced ? '/admin' : '/admin/settings';
      })
      .catch((e) => {
        setError(e.message);
        setBusy(false);
      });
  }, [completing, forced]);

  return (
    <div className="card">
      <h2>Link your Discord account</h2>
      <p className="muted">
        Your account signs in with a username and password. Linking Discord puts both identities on
        this one account, so signing in either way lands you here rather than on a second, empty
        account.
      </p>

      {error ? <div className="error">{error}</div> : null}

      {busy ? (
        <p className="muted">Linking...</p>
      ) : (
        <div className="row">
          <a className="button primary" href="/api/auth/discord/link">
            Link Discord
          </a>
          {forced ? (
            <button type="button" onClick={onSignOut}>
              Sign out
            </button>
          ) : (
            <Link className="button" to="/admin/settings">
              Back to settings
            </Link>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * The same step as a page of its own, for linking from Settings.
 *
 * @returns {JSX.Element} The page.
 */
export function LinkDiscordPage() {
  return (
    <div className="shell">
      <h1>Link Discord</h1>
      <LinkDiscord />
    </div>
  );
}
