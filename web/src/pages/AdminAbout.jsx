import { useEffect, useState } from 'react';
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

  useEffect(() => {
    api('/version').then((v) => setVersion(v.version)).catch(() => setVersion(''));
    api('/admin/me').then((me) => setIsSuper(Boolean(me.isSuperAdmin))).catch(() => setIsSuper(false));
    // Super-admin only on the server; a 403 for a plain admin just hides it.
    api('/admin/update').then(setUpdate).catch(() => setUpdate(null));
  }, []);

  return (
    <div className="shell">
      <h1>About</h1>

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
        <p className="muted" style={{ fontSize: '0.82rem', marginTop: '0.6rem' }}>
          Automatic updates and migrations are planned.
        </p>
      </div>
    </div>
  );
}
