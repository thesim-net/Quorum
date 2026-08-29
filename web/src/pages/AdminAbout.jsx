import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';

/**
 * About tab: the running version, and a pointer to Settings when a newer one
 * exists. Downloading and installing live there, with the schedule that governs
 * them, rather than being split across two pages.
 *
 * @returns {JSX.Element} The page.
 */
export function AdminAbout() {
  const [version, setVersion] = useState('');
  const [update, setUpdate] = useState(null);
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

      {update?.updateAvailable && isSuper ? (
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
              <Link className="button primary" to="/admin/settings">
                Update
              </Link>
            </span>
          </div>
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
