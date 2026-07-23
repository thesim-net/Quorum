import { Suspense, lazy, useEffect, useRef, useState } from 'react';
import { Link, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { api } from './api.js';
import { useTheme } from './theme.jsx';
import { Home } from './pages/Home.jsx';
import { TakeSurvey } from './pages/TakeSurvey.jsx';
import { Privacy } from './pages/Privacy.jsx';

// The admin panel pulls in the charting library, which participants never need.
// Loading it lazily keeps the bundle a survey-taker downloads small.
const AdminSurveys = lazy(() =>
  import('./pages/AdminSurveys.jsx').then((m) => ({ default: m.AdminSurveys })),
);
const SurveyEditor = lazy(() =>
  import('./pages/SurveyEditor.jsx').then((m) => ({ default: m.SurveyEditor })),
);
const SurveyResults = lazy(() =>
  import('./pages/SurveyResults.jsx').then((m) => ({ default: m.SurveyResults })),
);
const AdminSettings = lazy(() =>
  import('./pages/AdminSettings.jsx').then((m) => ({ default: m.AdminSettings })),
);
const Setup = lazy(() => import('./pages/Setup.jsx').then((m) => ({ default: m.Setup })));
const Plugins = lazy(() => import('./pages/Plugins.jsx').then((m) => ({ default: m.Plugins })));

/**
 * The "QUORUM" wordmark as standard-figlet ASCII art.
 *
 * Rendered small in a monospace <pre> and given a glitch animation in CSS. The
 * link carries an aria-label and the art is aria-hidden, so assistive tech
 * reads "Quorum home" rather than the block characters.
 */
const QUORUM_ASCII = [
  '  ___   _   _   ___   ____   _   _   __  __ ',
  ' / _ \\ | | | | / _ \\ |  _ \\ | | | ||  \\/  |',
  '| | | || | | || | | || |_) || | | || |\\/| |',
  '| |_| || |_| || |_| ||  _ < | |_| || |  | |',
  ' \\__\\_\\ \\___/  \\___/ |_| \\_\\ \\___/ |_|  |_|',
].join('\n');

/**
 * The signed-out landing screen.
 *
 * @returns {JSX.Element} A prompt to sign in with Discord.
 */
function SignIn({ devAuthBypass }) {
  const params = new URLSearchParams(window.location.search);
  const error = params.get('error');

  const messages = {
    not_in_guild: 'That Discord account is not a member of our server.',
    invalid_state: 'Sign-in expired. Please try again.',
  };

  /**
   * Signs in without Discord. Only reachable in local preview.
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

  return (
    <div className="shell">
      <div className="card">
        <h1>Sign in</h1>
        <p className="muted">
          These surveys are for our Discord community, so sign-in confirms you are a member of
          the server. Nothing is posted on your behalf.
        </p>
        {error ? <div className="error">{messages[error] ?? 'Sign-in failed.'}</div> : null}
        <a className="button primary" href="/api/auth/login">
          Continue with Discord
        </a>

        {devAuthBypass ? (
          <div className="disclosure" style={{ marginTop: '1.5rem' }}>
            <h3>Local preview mode</h3>
            <p className="muted" style={{ margin: '0 0 0.75rem' }}>
              Discord sign-in is bypassed because <code>DEV_AUTH_BYPASS</code> is set. This is
              never available on a real deployment.
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

/**
 * Shown when Discord has not been connected yet.
 *
 * @param {{error: string|null}} props `error` is set when stored credentials
 *   exist but can no longer be decrypted.
 * @returns {JSX.Element} The prompt.
 */
/**
 * The glitching "QUORUM" ASCII wordmark.
 *
 * Three CSS animations with coprime periods keep the loop from feeling
 * repetitive; a random per-load phase offset and glitch bursts fired at random
 * intervals add the rest of the unpredictability. When `still` (on the survey
 * page) it holds a clean, static frame so it does not pull focus.
 *
 * @param {{still: boolean}} props
 * @returns {JSX.Element} The wordmark.
 */
function BrandGlitch({ still }) {
  const ref = useRef(null);

  // A random negative delay per load starts each of the three animations at a
  // different point, so no two visits glitch in the same rhythm.
  const [delays] = useState(() =>
    [Math.random() * 6, Math.random() * 5, Math.random() * 7]
      .map((seconds) => `-${seconds.toFixed(2)}s`)
      .join(', '),
  );

  useEffect(() => {
    if (still) return undefined;

    let cancelled = false;
    let timer;

    // Fire a one-off intense glitch at a random interval, then reschedule.
    const tick = () => {
      timer = setTimeout(
        () => {
          if (cancelled) return;
          const el = ref.current;
          if (el) {
            el.classList.add('brand-ascii--burst');
            setTimeout(() => el.classList.remove('brand-ascii--burst'), 240);
          }
          tick();
        },
        2500 + Math.random() * 6500,
      );
    };
    tick();

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [still]);

  return (
    <pre
      ref={ref}
      className={`brand-ascii${still ? ' brand-ascii--still' : ''}`}
      style={still ? undefined : { animationDelay: delays }}
      aria-hidden="true"
    >
      {QUORUM_ASCII}
    </pre>
  );
}

/**
 * Skin picker and light/dark switch for the top bar.
 *
 * @returns {JSX.Element} The controls.
 */
function ThemeControls({ onChange }) {
  const { skin, mode, setSkin, dark, toggleMode, skins } = useTheme();

  return (
    <span className="theme-controls">
      <select
        className="skin-select"
        value={skin}
        onChange={(e) => {
          setSkin(e.target.value);
          onChange?.(e.target.value, mode);
        }}
        aria-label="Skin"
      >
        {skins.map((entry) => (
          <option key={entry.id} value={entry.id}>
            {entry.label}
          </option>
        ))}
      </select>
      <button
        type="button"
        onClick={() => {
          toggleMode();
          onChange?.(skin, dark ? 'light' : 'dark');
        }}
        aria-label={`Switch to ${dark ? 'light' : 'dark'} mode`}
      >
        {dark ? 'Light' : 'Dark'}
      </button>
    </span>
  );
}

/**
 * Site footer, shown on every screen including sign-in.
 *
 * @returns {JSX.Element} The footer.
 */
function Footer({ version }) {
  return (
    <footer className="site-footer">
      <Link to="/privacy">Data privacy</Link>
      <span className="footer-sep" aria-hidden="true">
        ·
      </span>
      Quorum{version ? ` v${version}` : ''} - Created by{' '}
      <a href="https://thomasloupe.com" target="_blank" rel="noreferrer">
        Thomas Loupe
      </a>
    </footer>
  );
}

function NeedsSetup({ error }) {
  return (
    <div className="shell">
      <div className="card">
        <h1>Setup needed</h1>
        {error === 'unreadable' ? (
          <div className="error">
            Stored Discord credentials could not be decrypted. This happens when SESSION_SECRET
            changes. Run setup again to reconnect.
          </div>
        ) : null}
        <p className="muted">
          This site is not connected to a Discord server yet. Open the one-time setup link printed
          in the container logs:
        </p>
        <pre className="codeblock">docker compose logs api | grep setup</pre>
      </div>
    </div>
  );
}

/**
 * Application shell: loads the session, then routes.
 *
 * @returns {JSX.Element} The app.
 */
export function App() {
  const location = useLocation();
  const { setSkin, applyMode } = useTheme();
  // Survey-taking lives at /s/:slug; the brand glitch is stilled there.
  const onSurvey = location.pathname.startsWith('/s/');
  const [user, setUser] = useState(undefined);
  const [devAuthBypass, setDevAuthBypass] = useState(false);
  const [setupState, setSetupState] = useState(null);
  const [version, setVersion] = useState('');

  useEffect(() => {
    Promise.all([
      api('/auth/me').catch(() => ({ user: null })),
      api('/setup/state').catch(() => ({ configured: true })),
      api('/version').catch(() => ({ version: '' })),
    ]).then(([me, setup, ver]) => {
      setUser(me.user);
      setDevAuthBypass(!!me.devAuthBypass);
      setSetupState(setup);
      setVersion(ver.version);

      // Apply the skin saved to this account, so a returning admin sees their
      // choice on any device rather than whatever this browser last used.
      if (me.user?.theme?.skin) setSkin(me.user.theme.skin);
      if (me.user?.theme?.mode) applyMode(me.user.theme.mode);
    });
  }, [setSkin, applyMode]);

  /**
   * Persists the signed-in member's skin and mode to their account.
   *
   * @param {string} skin
   * @param {string} mode
   */
  const saveTheme = (skin, mode) => {
    if (!user) return;
    api('/auth/theme', { method: 'PUT', body: { skin, mode } }).catch(() => {});
  };

  // The privacy page is public: someone deciding whether to take part must be
  // able to read it without signing in, and before setup is even complete.
  if (location.pathname === '/privacy') {
    return (
      <>
        <Privacy />
        <Footer version={version} />
      </>
    );
  }

  if (user === undefined || setupState === null) {
    return <div className="shell muted">Loading...</div>;
  }

  // Before Discord is connected nobody can sign in, so the wizard has to be
  // reachable without a session.
  if (!setupState.configured) {
    return (
      <>
        <Suspense fallback={<div className="shell muted">Loading...</div>}>
          <Routes>
            <Route path="/setup" element={<Setup />} />
            <Route path="*" element={<NeedsSetup error={setupState.error} />} />
          </Routes>
        </Suspense>
        <Footer version={version} />
      </>
    );
  }

  if (user === null) {
    return (
      <>
        <SignIn devAuthBypass={devAuthBypass} />
        <Footer version={version} />
      </>
    );
  }

  /** Ends the session and returns to the sign-in screen. */
  const logout = async () => {
    await api('/auth/logout', { method: 'POST' });
    window.location.href = '/';
  };

  return (
    <>
      <header className="topbar">
        <Link to="/" className="brand" aria-label="Quorum home">
          {/* The glitch is held still while a survey is being taken, so it does
              not pull focus from the questions. */}
          <BrandGlitch still={onSurvey} />
        </Link>
        <nav>
          {user.isAdmin ? <Link to="/surveys">Manage surveys</Link> : null}
          {user.isAdmin ? <Link to="/admin">Admin</Link> : null}
          <ThemeControls onChange={saveTheme} />
          <button type="button" onClick={logout}>
            Sign out
          </button>
        </nav>
      </header>

      <Suspense fallback={<div className="shell muted">Loading...</div>}>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/s/:slug" element={<TakeSurvey />} />
          {user.isAdmin ? (
            <>
              <Route path="/admin" element={<AdminSettings />} />
              <Route path="/surveys" element={<AdminSurveys />} />
              <Route path="/admin/surveys/:id" element={<SurveyEditor />} />
              <Route path="/admin/surveys/:id/results" element={<SurveyResults />} />
              <Route path="/plugins" element={<Plugins />} />
              {/* Setup is super admins only, enforced server-side too. */}
              {user.isSuperAdmin ? <Route path="/setup" element={<Setup />} /> : null}
            </>
          ) : null}
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Suspense>
      <Footer version={version} />
    </>
  );
}
