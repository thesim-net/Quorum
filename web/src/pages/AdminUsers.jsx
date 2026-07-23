import { useEffect, useState } from 'react';
import { api } from '../api.js';

/**
 * Admin access management.
 *
 * Super admins are unrestricted and manage everyone; plain admins hold only
 * granted permissions and never see that super admins exist, so the list a
 * plain admin sees is a strict subset filtered server-side.
 *
 * @returns {JSX.Element|null} The card, or null before the list loads.
 */
export function AdminUsers() {
  const [data, setData] = useState(null);
  const [discordId, setDiscordId] = useState('');
  const [superAdmin, setSuperAdmin] = useState(false);
  const [permissions, setPermissions] = useState([]);
  const [editing, setEditing] = useState(null);
  const [error, setError] = useState(null);
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState(false);

  /**
   * Reloads the admin list.
   *
   * @returns {Promise<void>}
   */
  const load = () =>
    api('/admin/admins')
      .then(setData)
      .catch((e) => setError(e.message));

  useEffect(() => {
    load();
  }, []);

  /**
   * Adds or removes a permission from a working set.
   *
   * @param {string[]} current Current selection.
   * @param {string} key Permission key.
   * @returns {string[]} Updated selection.
   */
  const toggle = (current, key) =>
    current.includes(key) ? current.filter((p) => p !== key) : [...current, key];

  /** Grants access to the entered Discord user id. */
  const add = async () => {
    const id = discordId.trim();
    if (!id) return;

    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      const result = await api('/admin/admins', {
        method: 'POST',
        body: { discordId: id, superAdmin, permissions },
      });
      setStatus(`${result.username} now has access.`);
      setDiscordId('');
      setSuperAdmin(false);
      setPermissions([]);
      await load();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  /**
   * Saves changed permissions for an existing admin.
   *
   * @param {object} admin The admin being edited.
   */
  const save = async (admin) => {
    setError(null);
    try {
      await api(`/admin/admins/${admin.id}`, {
        method: 'PATCH',
        body: { superAdmin: editing.superAdmin, permissions: editing.permissions },
      });
      setEditing(null);
      setStatus(`Updated ${admin.username}.`);
      await load();
    } catch (e) {
      setError(e.message);
    }
  };

  /**
   * Revokes all access.
   *
   * @param {object} admin The admin being removed.
   */
  const remove = async (admin) => {
    setError(null);
    try {
      await api(`/admin/admins/${admin.id}`, { method: 'DELETE' });
      setStatus(`Removed ${admin.username}.`);
      await load();
    } catch (e) {
      setError(e.message);
    }
  };

  if (!data) return null;

  const canManage = data.canManage;

  return (
    <div className="card">
      <h2>Admin access</h2>

      {error ? <div className="error">{error}</div> : null}
      {status ? <p className="muted">{status}</p> : null}

      {canManage ? (
        <>
          <div className="row" style={{ marginBottom: '0.5rem' }}>
            <input
              type="text"
              placeholder="Discord user ID"
              value={discordId}
              onChange={(e) => setDiscordId(e.target.value)}
              style={{ flex: 1 }}
            />
            <button type="button" className="primary" onClick={add} disabled={busy}>
              {busy ? 'Checking...' : 'Add'}
            </button>
          </div>

          <label className="option-row">
            <input
              type="checkbox"
              checked={superAdmin}
              onChange={(e) => setSuperAdmin(e.target.checked)}
            />
            <span>
              Super administrator
              <br />
              <span className="muted" style={{ fontSize: '0.82rem' }}>
                Everything, including managing admins and re-running setup.
              </span>
            </span>
          </label>

          {superAdmin ? null : (
            <div style={{ marginLeft: '1.6rem' }}>
              {data.catalogue.map((entry) => (
                <label className="option-row" key={entry.key}>
                  <input
                    type="checkbox"
                    checked={permissions.includes(entry.key)}
                    onChange={() => setPermissions((p) => toggle(p, entry.key))}
                  />
                  <span>
                    {entry.label}
                    <br />
                    <span className="muted" style={{ fontSize: '0.8rem' }}>{entry.detail}</span>
                  </span>
                </label>
              ))}
            </div>
          )}

          <p className="muted" style={{ fontSize: '0.82rem' }}>
            Enable Developer Mode in Discord, then right-click a member and Copy User ID. They must
            already be in the server.
          </p>
        </>
      ) : null}

      <table className="chart-table">
        <thead>
          <tr>
            <th scope="col">Admin</th>
            <th scope="col">Access</th>
            {canManage ? <th scope="col" /> : null}
          </tr>
        </thead>
        <tbody>
          {data.granted.map((admin) => (
            <tr key={admin.id}>
              <th scope="row" style={{ display: 'table-cell' }}>
                {admin.displayName || admin.username}
                {admin.isSelf ? (
                  <span className="badge" style={{ marginLeft: '0.5rem' }}>You</span>
                ) : null}
                <br />
                <span className="muted" style={{ fontSize: '0.8rem' }}>{admin.discordId}</span>
              </th>
              <td>
                {admin.tier === 'super_admin' ? (
                  <span className="badge">Super administrator</span>
                ) : (
                  <span className="muted" style={{ fontSize: '0.82rem' }}>
                    {admin.permissions
                      .map((p) => data.catalogue.find((c) => c.key === p)?.label ?? p)
                      .join(', ') || 'No permissions'}
                  </span>
                )}
              </td>
              {canManage ? (
                <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                  {admin.isSelf ? (
                    <span className="muted" style={{ fontSize: '0.8rem' }}>Ask another admin</span>
                  ) : (
                    <>
                      <button
                        type="button"
                        onClick={() =>
                          setEditing(
                            editing?.id === admin.id
                              ? null
                              : {
                                  id: admin.id,
                                  superAdmin: admin.tier === 'super_admin',
                                  permissions: [...admin.permissions],
                                },
                          )
                        }
                      >
                        Edit
                      </button>{' '}
                      <button type="button" className="danger" onClick={() => remove(admin)}>
                        Remove
                      </button>
                    </>
                  )}
                </td>
              ) : null}
            </tr>
          ))}

          {data.adminRoles.map((role) => (
            <tr key={role.id}>
              <th scope="row" style={{ display: 'table-cell' }}>
                Anyone with <strong>{role.name}</strong>
              </th>
              <td>
                <span className="muted" style={{ fontSize: '0.82rem' }}>
                  Discord role - full permissions, not super admin
                </span>
              </td>
              {canManage ? (
                <td style={{ textAlign: 'right' }}>
                  <span className="muted" style={{ fontSize: '0.8rem' }}>Change in setup</span>
                </td>
              ) : null}
            </tr>
          ))}

          {data.adminChannels.map((channel) => (
            <tr key={channel.id}>
              <th scope="row" style={{ display: 'table-cell' }}>
                Anyone who can see <strong>#{channel.name}</strong>
              </th>
              <td>
                <span className="muted" style={{ fontSize: '0.82rem' }}>
                  Discord channel - full permissions, not super admin
                </span>
              </td>
              {canManage ? (
                <td style={{ textAlign: 'right' }}>
                  <span className="muted" style={{ fontSize: '0.8rem' }}>Change in setup</span>
                </td>
              ) : null}
            </tr>
          ))}

          {data.bootstrapIds.map((id) => (
            <tr key={id}>
              <th scope="row" style={{ display: 'table-cell' }}>
                <span className="muted">{id}</span>
              </th>
              <td>
                <span className="muted" style={{ fontSize: '0.82rem' }}>
                  BOOTSTRAP_ADMIN_IDS - super admin
                </span>
              </td>
              {canManage ? <td /> : null}
            </tr>
          ))}
        </tbody>
      </table>

      {editing ? (
        <div className="confirm" style={{ borderLeftColor: 'var(--accent)' }}>
          <h3 style={{ color: 'var(--text-primary)' }}>Change access</h3>
          <label className="option-row">
            <input
              type="checkbox"
              checked={editing.superAdmin}
              onChange={(e) => setEditing({ ...editing, superAdmin: e.target.checked })}
            />
            <span>Super administrator</span>
          </label>
          {editing.superAdmin
            ? null
            : data.catalogue.map((entry) => (
                <label className="option-row" key={entry.key}>
                  <input
                    type="checkbox"
                    checked={editing.permissions.includes(entry.key)}
                    onChange={() =>
                      setEditing({
                        ...editing,
                        permissions: toggle(editing.permissions, entry.key),
                      })
                    }
                  />
                  <span>{entry.label}</span>
                </label>
              ))}
          <div className="row">
            <button type="button" onClick={() => setEditing(null)}>
              Cancel
            </button>
            <button
              type="button"
              className="primary"
              onClick={() => save(data.granted.find((a) => a.id === editing.id))}
            >
              Save
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
