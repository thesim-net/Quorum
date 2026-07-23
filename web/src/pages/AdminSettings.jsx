import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import { AdminUsers } from './AdminUsers.jsx';

/**
 * Administration: who has access, and how Discord is connected.
 *
 * Surveys live on their own page; nothing here is about running one.
 *
 * @returns {JSX.Element} The page.
 */
export function AdminSettings() {
  const [setupState, setSetupState] = useState(null);
  const [me, setMe] = useState(null);
  const [version, setVersion] = useState('');
  const [confirmSetup, setConfirmSetup] = useState(false);
  const navigate = useNavigate();

  useEffect(() => {
    api('/setup/state').then(setSetupState).catch(() => setSetupState(null));
    api('/admin/me').then(setMe).catch(() => setMe(null));
    api('/version').then((v) => setVersion(v.version)).catch(() => setVersion(''));
  }, []);

  if (!me) return <div className="shell muted">Loading...</div>;

  return (
    <div className="shell">
      <h1>Admin</h1>

      {/* Plain admins see a filtered, read-only version; the server decides
          what is in it. */}
      <AdminUsers />

      {setupState && me.isSuperAdmin ? (
        <div className="card">
          <h2>Discord</h2>
          <div className="row">
            <span className="badge">{setupState.guildName ?? 'Connected'}</span>
            {setupState.source === 'environment' ? (
              <span className="muted" style={{ fontSize: '0.82rem' }}>
                Configured by environment variables.
              </span>
            ) : null}
            <span style={{ marginLeft: 'auto' }} />
            {setupState.readOnly ? (
              <Link className="button" to="/setup">
                View connection
              </Link>
            ) : (
              <button type="button" onClick={() => setConfirmSetup(true)}>
                Re-run setup
              </button>
            )}
          </div>

          {confirmSetup ? (
            <div className="confirm">
              <h3>Are you absolutely certain?</h3>
              <p>
                This will break existing functionality. Pointing Quorum at a different Discord
                server orphans every role and channel gate on your surveys, and members of the old
                server lose access immediately.
              </p>
              <div className="row">
                <button type="button" onClick={() => setConfirmSetup(false)}>
                  Cancel
                </button>
                <button type="button" className="danger" onClick={() => navigate('/setup')}>
                  I understand, continue
                </button>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="card">
        <h2>About</h2>
        <div className="row">
          <span className="muted">Quorum version</span>
          <span className="badge">{version ? `v${version}` : 'unknown'}</span>
          <span style={{ marginLeft: 'auto' }} />
          <Link className="button" to="/plugins">
            Plugins
          </Link>
        </div>
        <p className="muted" style={{ fontSize: '0.82rem', marginTop: '0.6rem' }}>
          Automatic updates and migrations are planned.
        </p>
      </div>
    </div>
  );
}
