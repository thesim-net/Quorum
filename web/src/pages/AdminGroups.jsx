import { useEffect, useState } from 'react';
import { api } from '../api.js';

/**
 * Group management, super admins only.
 *
 * A group decides what its members may do to its own surveys, and can be given
 * permissions over another group's surveys. The default group is renamable but
 * cannot be deleted, and there is always exactly one.
 *
 * Every change is saved immediately and the list reloaded, so what is shown is
 * always what the server holds.
 *
 * @returns {JSX.Element} The page.
 */
export function AdminGroups() {
  const [data, setData] = useState(null);
  const [name, setName] = useState('');
  const [renaming, setRenaming] = useState(null);
  const [renameValue, setRenameValue] = useState('');
  const [addMember, setAddMember] = useState({});
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [error, setError] = useState(null);
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = () =>
    api('/admin/groups')
      .then(setData)
      .catch((e) => setError(e.message));

  useEffect(() => {
    load();
  }, []);

  /**
   * Runs a mutation, then reloads, surfacing any error.
   *
   * @param {() => Promise<void>} fn The API call.
   * @param {string|null} message A success note, if any.
   */
  const run = async (fn, message = null) => {
    setError(null);
    setStatus(null);
    setBusy(true);
    try {
      await fn();
      if (message) setStatus(message);
      await load();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  /** Creates a group. */
  const create = () =>
    run(async () => {
      await api('/admin/groups', { method: 'POST', body: { name: name.trim() } });
      setName('');
    }, 'Group created.');

  /**
   * Toggles one of a group's member permissions.
   *
   * @param {object} group The group.
   * @param {string} key The permission key.
   */
  const toggleMemberPermission = (group, key) => {
    const next = group.memberPermissions.includes(key)
      ? group.memberPermissions.filter((p) => p !== key)
      : [...group.memberPermissions, key];
    return run(() =>
      api(`/admin/groups/${group.id}`, { method: 'PATCH', body: { memberPermissions: next } }),
    );
  };

  /**
   * Toggles one permission of the grant this group holds over another.
   *
   * @param {object} group The source group.
   * @param {string} targetGroupId The group whose surveys are granted.
   * @param {string} key The permission key.
   */
  const toggleGrant = (group, targetGroupId, key) => {
    const existing = group.grants.find((g) => g.targetGroupId === targetGroupId);
    const current = existing?.permissions ?? [];
    const next = current.includes(key) ? current.filter((p) => p !== key) : [...current, key];
    return run(() =>
      api(`/admin/groups/${group.id}/grants`, {
        method: 'PUT',
        body: { targetGroupId, permissions: next },
      }),
    );
  };

  /** Saves an in-progress rename. */
  const saveRename = (group) =>
    run(async () => {
      await api(`/admin/groups/${group.id}`, { method: 'PATCH', body: { name: renameValue.trim() } });
      setRenaming(null);
    }, 'Group renamed.');

  /** Makes a group the default. */
  const makeDefault = (group) =>
    run(() => api(`/admin/groups/${group.id}`, { method: 'PATCH', body: { isDefault: true } }),
      `${group.name} is now the default group.`);

  /** Adds the selected admin to a group. */
  const addToGroup = (group) => {
    const userId = addMember[group.id];
    if (!userId) return undefined;
    return run(async () => {
      await api(`/admin/groups/${group.id}/members`, { method: 'POST', body: { userId } });
      setAddMember((m) => ({ ...m, [group.id]: '' }));
    });
  };

  /** Removes an admin from a group. */
  const removeMember = (group, member) =>
    run(() =>
      api(`/admin/groups/${group.id}/members/${member.id}`, { method: 'DELETE' }),
    );

  /** Deletes a group, reassigning its surveys to the default. */
  const destroy = (group) =>
    run(async () => {
      await api(`/admin/groups/${group.id}`, { method: 'DELETE' });
      setConfirmDelete(null);
    }, `Removed ${group.name}.`);

  if (!data) return <div className="shell muted">Loading...</div>;

  const label = (key) => data.catalogue.find((c) => c.key === key)?.label ?? key;

  return (
    <div className="shell">
      <h1>Groups</h1>
      <p className="muted">
        A group decides what its members can do to its own surveys, and can be granted access to
        another group&rsquo;s surveys. Membership is explicit and works the same with or without
        Discord.
      </p>

      {error ? <div className="error">{error}</div> : null}
      {status ? <p className="muted">{status}</p> : null}

      <div className="card">
        <div className="row">
          <input
            type="text"
            placeholder="New group name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && name.trim() && create()}
            style={{ flex: 1 }}
          />
          <button type="button" className="primary" onClick={create} disabled={busy || !name.trim()}>
            Create group
          </button>
        </div>
      </div>

      {data.groups.map((group) => {
        const memberIds = new Set(group.members.map((m) => m.id));
        const assignable = data.admins.filter((a) => !memberIds.has(a.id));
        const otherGroups = data.groups.filter((g) => g.id !== group.id);

        return (
          <div className="card" key={group.id}>
            <div className="row">
              {renaming === group.id ? (
                <>
                  <input
                    type="text"
                    value={renameValue}
                    onChange={(e) => setRenameValue(e.target.value)}
                    style={{ flex: 1 }}
                  />
                  <button
                    type="button"
                    className="primary"
                    onClick={() => saveRename(group)}
                    disabled={busy || !renameValue.trim()}
                  >
                    Save
                  </button>
                  <button type="button" onClick={() => setRenaming(null)}>
                    Cancel
                  </button>
                </>
              ) : (
                <>
                  <h2 style={{ margin: 0 }}>{group.name}</h2>
                  {group.isDefault ? <span className="badge">Default</span> : null}
                  <span style={{ marginLeft: 'auto' }} />
                  <button
                    type="button"
                    onClick={() => {
                      setRenaming(group.id);
                      setRenameValue(group.name);
                    }}
                  >
                    Rename
                  </button>
                  {group.isDefault ? null : (
                    <button type="button" onClick={() => makeDefault(group)} disabled={busy}>
                      Make default
                    </button>
                  )}
                  {group.isDefault ? null : (
                    <button
                      type="button"
                      className="danger"
                      onClick={() => setConfirmDelete(group.id)}
                    >
                      Delete
                    </button>
                  )}
                </>
              )}
            </div>

            <h3 style={{ marginBottom: '0.2rem' }}>What members can do</h3>
            <p className="muted" style={{ fontSize: '0.82rem', marginTop: 0 }}>
              Applies to surveys this group owns.
            </p>
            {data.catalogue.map((entry) => (
              <label className="option-row" key={entry.key}>
                <input
                  type="checkbox"
                  checked={group.memberPermissions.includes(entry.key)}
                  disabled={busy}
                  onChange={() => toggleMemberPermission(group, entry.key)}
                />
                <span>
                  {entry.label}
                  <br />
                  <span className="muted" style={{ fontSize: '0.8rem' }}>{entry.detail}</span>
                </span>
              </label>
            ))}

            <h3 style={{ marginBottom: '0.2rem' }}>Members</h3>
            {group.members.length === 0 ? (
              <p className="muted" style={{ fontSize: '0.85rem', marginTop: 0 }}>No members yet.</p>
            ) : (
              <table className="chart-table">
                <tbody>
                  {group.members.map((member) => (
                    <tr key={member.id}>
                      <th scope="row" style={{ display: 'table-cell' }}>
                        {member.displayName || member.username}
                        {member.tier === 'super_admin' ? (
                          <span className="badge" style={{ marginLeft: '0.5rem' }}>
                            Super administrator
                          </span>
                        ) : null}
                      </th>
                      <td style={{ textAlign: 'right' }}>
                        <button type="button" onClick={() => removeMember(group, member)} disabled={busy}>
                          Remove
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}

            <div className="row" style={{ marginTop: '0.5rem' }}>
              <select
                value={addMember[group.id] ?? ''}
                onChange={(e) => setAddMember((m) => ({ ...m, [group.id]: e.target.value }))}
                style={{ flex: 1 }}
                disabled={assignable.length === 0}
              >
                <option value="">
                  {assignable.length === 0 ? 'Every admin is already a member' : 'Add an admin...'}
                </option>
                {assignable.map((admin) => (
                  <option key={admin.id} value={admin.id}>
                    {admin.displayName || admin.username}
                    {admin.tier === 'super_admin' ? ' (super)' : ''}
                  </option>
                ))}
              </select>
              <button
                type="button"
                onClick={() => addToGroup(group)}
                disabled={busy || !addMember[group.id]}
              >
                Add
              </button>
            </div>
            {group.members.some((m) => m.tier === 'super_admin') ? (
              <p className="muted" style={{ fontSize: '0.8rem' }}>
                Super administrators already have every permission everywhere; membership does not
                change what they can do.
              </p>
            ) : null}

            {otherGroups.length > 0 ? (
              <>
                <h3 style={{ marginBottom: '0.2rem' }}>Access to other groups&rsquo; surveys</h3>
                <p className="muted" style={{ fontSize: '0.82rem', marginTop: 0 }}>
                  Tick what this group&rsquo;s members may do to another group&rsquo;s surveys.
                </p>
                {otherGroups.map((target) => {
                  const grant = group.grants.find((g) => g.targetGroupId === target.id);
                  const granted = grant?.permissions ?? [];
                  return (
                    <div key={target.id} style={{ marginBottom: '0.5rem' }}>
                      <strong style={{ fontSize: '0.9rem' }}>{target.name}</strong>
                      <div style={{ marginLeft: '1rem' }}>
                        {data.catalogue.map((entry) => (
                          <label
                            className="option-row"
                            key={entry.key}
                            style={{ padding: '0.25rem 0' }}
                          >
                            <input
                              type="checkbox"
                              checked={granted.includes(entry.key)}
                              disabled={busy}
                              onChange={() => toggleGrant(group, target.id, entry.key)}
                            />
                            <span style={{ fontSize: '0.85rem' }}>{label(entry.key)}</span>
                          </label>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </>
            ) : null}

            {confirmDelete === group.id ? (
              <div className="confirm">
                <h3>Delete this group?</h3>
                <p>
                  Its surveys will be reassigned to the default group, and its members and grants
                  removed. This cannot be undone.
                </p>
                <div className="row">
                  <button type="button" onClick={() => setConfirmDelete(null)}>
                    Cancel
                  </button>
                  <button type="button" className="danger" onClick={() => destroy(group)}>
                    Delete &ldquo;{group.name}&rdquo;
                  </button>
                </div>
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
