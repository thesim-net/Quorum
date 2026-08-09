import { useEffect, useState } from 'react';
import { api } from '../api.js';

/**
 * Admin access management.
 *
 * Super admins are unrestricted and manage everyone; plain admins hold only
 * granted permissions and never see that super admins exist, so the list a
 * plain admin sees is a strict subset filtered server-side.
 *
 * Admins are created as local accounts (username plus a one-time password
 * shown exactly once), or granted to a Discord member when that plugin is
 * connected.
 *
 * @returns {JSX.Element|null} The card, or null before the list loads.
 */
export function AdminUsers() {
  const [data, setData] = useState(null);
  const [mode, setMode] = useState('local');
  const [username, setUsername] = useState('');
  const [discordId, setDiscordId] = useState('');
  const [superAdmin, setSuperAdmin] = useState(false);
  const [permissions, setPermissions] = useState([]);
  const [editing, setEditing] = useState(null);
  const [error, setError] = useState(null);
  const [status, setStatus] = useState(null);
  // A freshly minted one-time password, shown until dismissed.
  const [oneTime, setOneTime] = useState(null);
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

  /** Creates a local admin, or grants access to a Discord member. */
  const add = async () => {
    setBusy(true);
    setError(null);
    setStatus(null);
    setOneTime(null);
    try {
      if (mode === 'discord') {
        const result = await api('/plugin/discord/admins', {
          method: 'POST',
          body: { discordId: discordId.trim(), superAdmin, permissions },
        });
        setStatus(`${result.username} now has access.`);
        setDiscordId('');
      } else {
        const result = await api('/admin/admins', {
          method: 'POST',
          body: { username: username.trim(), superAdmin, permissions },
        });
        setOneTime({ username: result.username, password: result.password });
        setUsername('');
      }
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

  /**
   * Resets a local admin's password to a fresh one-time value.
   *
   * @param {object} admin The admin whose password is reset.
   */
  const resetPassword = async (admin) => {
    setError(null);
    setStatus(null);
    setOneTime(null);
    try {
      const result = await api(`/admin/admins/${admin.id}/password`, { method: 'POST' });
      setOneTime({ username: result.username, password: result.password, reset: true });
    } catch (e) {
      setError(e.message);
    }
  };

  /**
   * Toggles whether an admin must use two-factor authentication.
   *
   * @param {object} admin The admin being changed.
   */
  const toggleTotpRequired = async (admin) => {
    setError(null);
    try {
      await api(`/plugin/twofactor/require/${admin.id}`, {
        method: 'PUT',
        body: { required: !admin.totpRequired },
      });
      setStatus(
        `2FA is ${admin.totpRequired ? 'no longer' : 'now'} required for ${admin.username}.`,
      );
      await load();
    } catch (e) {
      setError(e.message);
    }
  };

  if (!data) return null;

  const canManage = data.canManage;
  const discordOn = Boolean(data.plugins?.discord);
  const twofactorOn = Boolean(data.plugins?.twofactor);

  return (
    <div className="card">
      <h2>Admin access</h2>

      {error ? <div className="error">{error}</div> : null}
      {status ? <p className="muted">{status}</p> : null}

      {oneTime ? (
        <div className="confirm" style={{ borderLeftColor: 'var(--accent)' }}>
          <h3 style={{ color: 'var(--text-primary)' }}>
            One-time password for {oneTime.username}
          </h3>
          <p>
            {oneTime.reset ? 'The password has been reset.' : 'The account has been created.'} Hand
            this password over securely; it is shown only once, and they should change it after
            signing in.
          </p>
          <pre className="codeblock">{oneTime.password}</pre>
          <button type="button" onClick={() => setOneTime(null)}>
            I have copied it
          </button>
        </div>
      ) : null}

      {canManage ? (
        <>
          {discordOn ? (
            <div className="row" style={{ marginBottom: '0.5rem' }}>
              <label className="option-row" style={{ marginBottom: 0 }}>
                <input
                  type="radio"
                  name="admin-add-mode"
                  checked={mode === 'local'}
                  onChange={() => setMode('local')}
                />
                <span>Local account</span>
              </label>
              <label className="option-row" style={{ marginBottom: 0 }}>
                <input
                  type="radio"
                  name="admin-add-mode"
                  checked={mode === 'discord'}
                  onChange={() => setMode('discord')}
                />
                <span>Discord member</span>
              </label>
            </div>
          ) : null}

          <div className="row" style={{ marginBottom: '0.5rem' }}>
            {mode === 'discord' && discordOn ? (
              <input
                type="text"
                placeholder="Discord user ID"
                value={discordId}
                onChange={(e) => setDiscordId(e.target.value)}
                style={{ flex: 1 }}
              />
            ) : (
              <input
                type="text"
                placeholder="Username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                style={{ flex: 1 }}
              />
            )}
            <button
              type="button"
              className="primary"
              onClick={add}
              disabled={busy || (mode === 'discord' && discordOn ? !discordId.trim() : !username.trim())}
            >
              {busy ? 'Adding...' : 'Add'}
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
                Everything, including managing admins and plugins.
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

          {mode === 'discord' && discordOn ? (
            <p className="muted" style={{ fontSize: '0.82rem' }}>
              Enable Developer Mode in Discord, then right-click a member and Copy User ID. They
              must already be in the server.
            </p>
          ) : (
            <p className="muted" style={{ fontSize: '0.82rem' }}>
              A one-time password is generated and shown once; the new admin signs in with it and
              changes it.
            </p>
          )}
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
                <span className="muted" style={{ fontSize: '0.8rem' }}>
                  {admin.discordId ?? 'Local account'}
                </span>
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
                {twofactorOn ? (
                  <>
                    <br />
                    <span className="muted" style={{ fontSize: '0.8rem' }}>
                      2FA: {admin.totpEnrolled ? 'enrolled' : 'not enrolled'}
                      {admin.totpRequired ? ', required' : ''}
                    </span>
                  </>
                ) : null}
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
                      {admin.local ? (
                        <>
                          <button type="button" onClick={() => resetPassword(admin)}>
                            Reset password
                          </button>{' '}
                        </>
                      ) : null}
                      {twofactorOn ? (
                        <>
                          <button type="button" onClick={() => toggleTotpRequired(admin)}>
                            {admin.totpRequired ? 'Unrequire 2FA' : 'Require 2FA'}
                          </button>{' '}
                        </>
                      ) : null}
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
                  <span className="muted" style={{ fontSize: '0.8rem' }}>
                    Change in the Discord plugin settings
                  </span>
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
                  <span className="muted" style={{ fontSize: '0.8rem' }}>
                    Change in the Discord plugin settings
                  </span>
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
