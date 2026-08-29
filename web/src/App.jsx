import { Suspense, lazy, useEffect, useRef, useState } from 'react';
import { Link, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { api } from './api.js';
import { useTheme } from './theme.jsx';
import { Home } from './pages/Home.jsx';
import { TakeSurvey } from './pages/TakeSurvey.jsx';
import { Privacy } from './pages/Privacy.jsx';
import { Verify } from './pages/Verify.jsx';
import { SignIn } from './pages/SignIn.jsx';

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
const SurveyRespondents = lazy(() =>
  import('./pages/SurveyRespondents.jsx').then((m) => ({ default: m.SurveyRespondents })),
);
const SurveyResponse = lazy(() =>
  import('./pages/SurveyRespondents.jsx').then((m) => ({ default: m.SurveyResponse })),
);
const AdminSettings = lazy(() =>
  import('./pages/AdminSettings.jsx').then((m) => ({ default: m.AdminSettings })),
);
const Setup = lazy(() => import('./pages/Setup.jsx').then((m) => ({ default: m.Setup })));
const Plugins = lazy(() => import('./pages/Plugins.jsx').then((m) => ({ default: m.Plugins })));
const DiscordSettings = lazy(() =>
  import('./pages/DiscordSettings.jsx').then((m) => ({ default: m.DiscordSettings })),
);
const AdminLayout = lazy(() =>
  import('./pages/AdminLayout.jsx').then((m) => ({ default: m.AdminLayout })),
);
const AdminUsersPage = lazy(() =>
  import('./pages/AdminUsersPage.jsx').then((m) => ({ default: m.AdminUsersPage })),
);
const AdminGroups = lazy(() =>
  import('./pages/AdminGroups.jsx').then((m) => ({ default: m.AdminGroups })),
);
const AdminAbout = lazy(() =>
  import('./pages/AdminAbout.jsx').then((m) => ({ default: m.AdminAbout })),
);
const FinishSetup = lazy(() =>
  import('./pages/FinishSetup.jsx').then((m) => ({ default: m.FinishSetup })),
);
const LinkDiscordPage = lazy(() =>
  import('./pages/LinkDiscord.jsx').then((m) => ({ default: m.LinkDiscordPage })),
);

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
 * Verification pill shown in the footer.
 *
 * Glyph plus label, never colour alone, so the state is legible without colour
 * vision. It links to the full /verify page rather than asserting proof on its
 * own: the badge is the running server's self-report, and the page is candid
 * about what that is worth versus the independent check.
 */
const VERIFY_BADGE = {
  verified: { cls: 'ok', glyph: '✓', label: 'Verified build' },
  unverified: { cls: 'warn', glyph: '⚠', label: 'Unverified build' },
  local: { cls: 'muted', glyph: '•', label: 'Local build' },
  unknown: { cls: 'muted', glyph: '•', label: 'Verify build' },
};

/**
 * Site footer, shown on every screen including sign-in.
 *
 * The commit link reports the commit the running build claims to be from; the
 * verification pill links to /verify, which resolves the running image against
 * its published provenance and hands out the independent check.
 *
 * @param {object} props
 * @param {{version?: string, commit?: string, repo?: string}} props.build Build
 *   metadata from /api/version.
 * @param {string} [props.attestState] Attestation state from /api/attestation.
 * @returns {JSX.Element} The footer.
 */
function Footer({ build, attestState }) {
  const { version, commit, repo } = build || {};
  const shortSha = commit && commit !== 'unknown' ? commit.slice(0, 7) : '';
  const badge = VERIFY_BADGE[attestState] ?? VERIFY_BADGE.unknown;
  return (
    <footer className="site-footer">
      <Link to="/privacy">Data privacy</Link>
      <span className="footer-sep" aria-hidden="true">
        ·
      </span>
      <Link to="/verify" className={`verify-badge verify-${badge.cls}`}>
        <span aria-hidden="true">{badge.glyph}</span> {badge.label}
      </Link>
      <span className="footer-sep" aria-hidden="true">
        ·
      </span>
      Quorum{version ? ` v${version}` : ''}
      {shortSha ? (
        <>
          {' · '}
          <a
            className="footer-commit"
            href={`https://github.com/${repo}/commit/${commit}`}
            target="_blank"
            rel="noreferrer"
          >
            {shortSha}
          </a>
        </>
      ) : null}
      {' - Created by '}
      <a href="https://thomasloupe.com" target="_blank" rel="noreferrer">
        Thomas Loupe
      </a>
    </footer>
  );
}

/**
 * Shown before the first administrator account exists.
 *
 * @returns {JSX.Element} The prompt.
 */
function NeedsSetup() {
  return (
    <div className="shell">
      <div className="card">
        <h1>Setup needed</h1>
        <p className="muted">
          This deployment has no administrator yet. Open the one-time setup link printed in the
          container logs to create the first admin account:
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
  const [build, setBuild] = useState({ version: '', commit: '', repo: '' });
  const [attestState, setAttestState] = useState(undefined);
  // Resolved wordmark-animation setting: user preference, else this browser's
  // choice, else the deployment default (with reduced-motion as default-off).
  const [asciiAnimation, setAsciiAnimation] = useState(null);

  useEffect(() => {
    Promise.all([
      api('/auth/me').catch(() => ({ user: null })),
      api('/setup/state').catch(() => ({ configured: true })),
      api('/version').catch(() => ({})),
    ]).then(([me, setup, ver]) => {
      setUser(me.user);
      setDevAuthBypass(!!me.devAuthBypass);
      setSetupState(setup);
      setBuild({ version: ver.version || '', commit: ver.commit || '', repo: ver.repo || '' });

      // Apply the skin saved to this account, so a returning admin sees their
      // choice on any device rather than whatever this browser last used.
      if (me.user?.theme?.skin) setSkin(me.user.theme.skin);
      if (me.user?.theme?.mode) applyMode(me.user.theme.mode);

      // Resolve the wordmark animation: an explicit user or browser preference
      // wins; otherwise the deployment default, dropped to off when the browser
      // asks for reduced motion.
      const stored = localStorage.getItem('quorum-ascii-animation');
      const storedPref = stored === '1' ? true : stored === '0' ? false : null;
      const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      const deploymentDefault = me.asciiAnimationDefault !== false;
      if (typeof me.user?.asciiAnimation === 'boolean') setAsciiAnimation(me.user.asciiAnimation);
      else if (storedPref !== null) setAsciiAnimation(storedPref);
      else setAsciiAnimation(deploymentDefault && !reduced);
    });

    // The attestation check reaches out to GHCR and GitHub, so it is fetched
    // on its own rather than gating the app render behind it. The footer badge
    // simply appears once it resolves.
    api('/attestation')
      .then((a) => setAttestState(a.state))
      .catch(() => setAttestState('unknown'));
  }, [setSkin, applyMode]);

  /**
   * Persists the signed-in account's skin and mode.
   *
   * @param {string} skin
   * @param {string} mode
   */
  const saveTheme = (skin, mode) => {
    if (!user) return;
    api('/auth/theme', { method: 'PUT', body: { skin, mode } }).catch(() => {});
  };

  /**
   * Toggles the wordmark animation and persists the choice: to the account when
   * signed in, otherwise to this browser.
   */
  const toggleAscii = () => {
    setAsciiAnimation((prev) => {
      const next = !prev;
      if (user) api('/auth/prefs', { method: 'PUT', body: { asciiAnimation: next } }).catch(() => {});
      else localStorage.setItem('quorum-ascii-animation', next ? '1' : '0');
      return next;
    });
  };

  // The privacy page is public: someone deciding whether to take part must be
  // able to read it without signing in, and before setup is even complete.
  if (location.pathname === '/privacy') {
    return (
      <>
        <Privacy />
        <Footer build={build} attestState={attestState} />
      </>
    );
  }

  // Build verification is public too: anyone should be able to check what this
  // deployment is running, signed in or not, configured or not.
  if (location.pathname === '/verify') {
    return (
      <>
        <Verify />
        <Footer build={build} attestState={attestState} />
      </>
    );
  }

  if (user === undefined || setupState === null) {
    return <div className="shell muted">Loading...</div>;
  }

  // Until a super admin exists nobody can sign in, so the setup form has to be
  // reachable without a session and everything else waits.
  if (!setupState.configured) {
    return (
      <>
        <Suspense fallback={<div className="shell muted">Loading...</div>}>
          <Routes>
            <Route path="/setup" element={<Setup />} />
            <Route path="*" element={<NeedsSetup />} />
          </Routes>
        </Suspense>
        <Footer build={build} attestState={attestState} />
      </>
    );
  }

  /** Ends the session and returns to the surveys list. */
  const logout = async () => {
    await api('/auth/logout', { method: 'POST' });
    window.location.href = '/';
  };

  return (
    <>
      <header className="topbar">
        {/* Clicking the wordmark toggles its own animation (an accessibility
            control). It is held still while a survey is being taken, so it does
            not pull focus from the questions. */}
        <button
          type="button"
          className="brand brand-toggle"
          onClick={toggleAscii}
          title={asciiAnimation === false ? 'Click to animate the wordmark' : 'Click to stop the animation'}
          aria-label={
            asciiAnimation === false
              ? 'Animate the Quorum wordmark'
              : 'Stop the Quorum wordmark animation'
          }
        >
          <BrandGlitch still={onSurvey || asciiAnimation === false} />
        </button>
        <nav>
          <Link to="/">Home</Link>
          {user?.isAdmin ? <Link to="/admin/surveys">Manage surveys</Link> : null}
          {user?.isAdmin ? <Link to="/admin">Admin</Link> : null}
          <ThemeControls onChange={saveTheme} />
          {user ? (
            <button type="button" onClick={logout}>
              Sign out
            </button>
          ) : (
            <Link to="/login">Sign in</Link>
          )}
        </nav>
      </header>

      <Suspense fallback={<div className="shell muted">Loading...</div>}>
        <Routes>
          <Route path="/" element={<Home user={user} />} />
          <Route path="/s/:slug" element={<TakeSurvey />} />
          <Route
            path="/login"
            element={user ? <Navigate to="/" replace /> : <SignIn devAuthBypass={devAuthBypass} />}
          />
          {user?.isAdmin && user.onboardingStep ? (
            <>
              {/* Setting credentials and linking Discord are one flow with a
                  fixed order, decided server-side, so the whole admin area
                  resolves to whichever single step is outstanding. Nothing here
                  chooses between them, which is what stops the two forced steps
                  from bouncing an admin back and forth. */}
              <Route path="/admin/*" element={<FinishSetup user={user} onSignOut={logout} />} />
              <Route path="/surveys" element={<Navigate to="/admin" replace />} />
              <Route path="/plugins" element={<Navigate to="/admin" replace />} />
            </>
          ) : user?.isAdmin ? (
            <>
              {/* Tabbed admin area; each tab is its own deep-linkable route. */}
              <Route path="/admin" element={<AdminLayout user={user} />}>
                <Route index element={<Navigate to="surveys" replace />} />
                <Route path="surveys" element={<AdminSurveys />} />
                <Route path="users" element={<AdminUsersPage />} />
                {/* Also for anybody who administers a group: the page shows
                    them their own groups, and the API sends nothing else. */}
                {user.isSuperAdmin || user.administersAGroup ? (
                  <Route path="groups" element={<AdminGroups />} />
                ) : null}
                {user.isSuperAdmin ? <Route path="plugins" element={<Plugins />} /> : null}
                <Route path="settings" element={<AdminSettings />} />
                <Route path="about" element={<AdminAbout />} />
              </Route>
              {/* Survey detail views are full pages, so they sit outside the tab
                  layout rather than under it. */}
              <Route path="/admin/surveys/:id" element={<SurveyEditor />} />
              <Route path="/admin/surveys/:id/results" element={<SurveyResults />} />
              <Route path="/admin/surveys/:id/responses" element={<SurveyRespondents />} />
              <Route
                path="/admin/surveys/:id/responses/:responseId"
                element={<SurveyResponse />}
              />
              {/* Linking Discord from Settings lands back here, the same page
                  the forced step uses, so both routes finish the same way. */}
              <Route path="/admin/link-discord" element={<LinkDiscordPage />} />
              {/* The Discord wizard is super admins only, enforced server-side
                  too. Reachable while the plugin is off, so a server can be
                  connected before switching it on. */}
              {user.isSuperAdmin ? (
                <Route path="/admin/plugins/discord" element={<DiscordSettings />} />
              ) : null}
              {/* Old top-level paths still resolve after the move under /admin. */}
              <Route path="/surveys" element={<Navigate to="/admin/surveys" replace />} />
              <Route path="/plugins" element={<Navigate to="/admin/plugins" replace />} />
            </>
          ) : null}
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Suspense>
      <Footer build={build} attestState={attestState} />
    </>
  );
}
