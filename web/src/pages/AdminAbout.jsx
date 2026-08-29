import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';

/**
 * About tab: the running version, the update banner, and a link to plugins.
 *
 * @returns {JSX.Element} The page.
 */
export function AdminAbout() {
  const [version, setVersion] = useState('');
  const [update, setUpdate] = useState(null);
  const [showUpdate, setShowUpdate] = useState(false);
  const [isSuper, setIsSuper] = useState(false);
  // A version already downloaded and waiting, as opposed to merely available.
  const [auto, setAuto] = useState(null);
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState(null);
  const [applied, setApplied] = useState(false);
  const pollRef = useRef(null);

  // The poll outlives the click that started it.
  useEffect(() => () => clearInterval(pollRef.current), []);

  useEffect(() => {
    api('/version').then((v) => setVersion(v.version)).catch(() => setVersion(''));
    api('/admin/me').then((me) => setIsSuper(Boolean(me.isSuperAdmin))).catch(() => setIsSuper(false));
    // Super-admin only on the server; a 403 for a plain admin just hides it.
    api('/admin/update').then(setUpdate).catch(() => setUpdate(null));
    api('/admin/update/auto').then(setAuto).catch(() => setAuto(null));
  }, []);

  /**
   * Restarts into the downloaded version. The reply comes from a process about
   * to be stopped, so it means the handover started, not that it finished.
   */
  const applyUpdate = async () => {
    setApplying(true);
    setApplyError(null);
    try {
      const result = await api('/admin/update/apply', { method: 'POST' });
      if (result.status !== 'restarting') {
        setApplyError(result.message ?? `Could not restart: ${result.status}.`);
        setApplying(false);
        return;
      }
      setApplied(true);
      // Poll rather than reload blindly, into a container still coming up.
      // In a ref because this is not an effect and cannot return a cleanup.
      pollRef.current = setInterval(() => {
        api('/version')
          .then((v) => {
            if (v.version && v.version !== version) window.location.reload();
          })
          .catch(() => {});
      }, 3000);
    } catch (e) {
      setApplyError(e.message);
      setApplying(false);
    }
  };

  return (
    <div className="shell">
      <h1>About</h1>

      {auto?.stagedVersion ? (
        <div className="update-banner">
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <span>
              <strong>Update downloaded:</strong> Quorum {auto.stagedVersion} is on this host,
              waiting to be applied.
              <br />
              <span className="muted" style={{ fontSize: '0.82rem' }}>
                Restarting interrupts anyone part-way through a survey, and runs migrations on the
                way back up.
              </span>
            </span>
            <button
              type="button"
              className="primary"
              disabled={applying || applied}
              onClick={applyUpdate}
            >
              {applied ? 'Restarting...' : applying ? 'Starting...' : 'Upgrade and restart Quorum'}
            </button>
          </div>
          {applyError ? <div className="error">{applyError}</div> : null}
          {applied ? (
            <p className="muted" style={{ fontSize: '0.82rem', marginBottom: 0 }}>
              Quorum is restarting into {auto.stagedVersion}. This page reloads once it answers
              again.
            </p>
          ) : null}
        </div>
      ) : null}

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

      <div className="card">
        <h2>About</h2>
        <div className="row">
          <span className="muted">Quorum version</span>
          <span className="badge">{version ? `v${version}` : 'unknown'}</span>
          {isSuper ? (
            <>
              <span style={{ marginLeft: 'auto' }} />
              <Link className="button" to="/admin/plugins">
                Plugins
              </Link>
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}
