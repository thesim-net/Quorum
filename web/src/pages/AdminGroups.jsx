import { useEffect, useState } from 'react';
import { api } from '../api.js';
import {
  findGrant,
  grantTargets,
  listGrants,
  permissionNames,
  togglePermission,
} from '../lib/grants.js';

/**
 * The index of groups, on the left of the first section.
 *
 * One line per group and nothing else: picking a line is the only thing that
 * changes the pane beside it, so the page never shows more than one group's
 * controls at a time.
 *
 * @param {{groups: object[], selectedId: string, onSelect: (id: string) => void}} props
 * @returns {JSX.Element} The list.
 */
function GroupList({ groups, selectedId, onSelect }) {
  return (
    <ul className="pick-list">
      {groups.map((group) => {
        const current = group.id === selectedId;
        return (
          <li key={group.id}>
            <button
              type="button"
              className="pick-item"
              // aria-current announces the selection, and the marker column
              // shows it without relying on the highlight colour.
              aria-current={current ? 'true' : undefined}
              onClick={() => onSelect(group.id)}
            >
              <span className="pick-mark" aria-hidden="true">
                {current ? '▸' : ''}
              </span>
              <span className="pick-body">
                <span className="pick-name">{group.name}</span>
                <span className="pick-meta">
                  {group.members.length} member{group.members.length === 1 ? '' : 's'}
                  {group.isDefault ? ' · Default' : ''}
                </span>
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Everything about the one selected group: its name, what its members may do,
 * who they are, and removing it.
 *
 * Mounted with the group's id as its key, so switching group resets the fields
 * rather than carrying a half-typed rename across.
 *
 * @param {{group: object, admins: object[], catalogue: object[], busy: boolean,
 *   canManageGroups: boolean,
 *   onRename: (name: string) => void, onMakeDefault: () => void,
 *   onDelete: () => void, onTogglePermission: (key: string) => void,
 *   onAddMember: (userId: string, isAdmin: boolean) => Promise<void>,
 *   onSetMemberAdmin: (member: object, isAdmin: boolean) => void,
 *   onRemoveMember: (member: object) => void}} props
 * @returns {JSX.Element} The detail pane.
 */
function GroupDetail({
  group,
  admins,
  catalogue,
  busy,
  canManageGroups,
  onRename,
  onMakeDefault,
  onDelete,
  onTogglePermission,
  onAddMember,
  onSetMemberAdmin,
  onRemoveMember,
}) {
  const [name, setName] = useState(group.name);
  const [memberId, setMemberId] = useState('');
  const [memberIsAdmin, setMemberIsAdmin] = useState(false);
  const [confirming, setConfirming] = useState(false);
  // Taking somebody's access away is destructive, so it is confirmed in place
  // rather than done on a single click, the same as deleting the group.
  const [removing, setRemoving] = useState(null);

  const memberIds = new Set(group.members.map((member) => member.id));
  const assignable = admins.filter((admin) => !memberIds.has(admin.id));
  const renamed = name.trim() && name.trim() !== group.name;

  return (
    <section className="split-main" aria-labelledby="group-detail-name">
      <div className="row">
        <h3 id="group-detail-name" style={{ margin: 0 }}>
          {group.name}
        </h3>
        {group.isDefault ? <span className="badge">Default</span> : null}
        <span style={{ marginLeft: 'auto' }} />
        {canManageGroups && !group.isDefault ? (
          <button type="button" onClick={onMakeDefault} disabled={busy}>
            Make default
          </button>
        ) : null}
        {canManageGroups && !group.isDefault ? (
          <button type="button" className="danger" onClick={() => setConfirming(true)}>
            Delete
          </button>
        ) : null}
      </div>

      {/* Renaming a group, and deciding what its members may do, shapes the
          deployment; an administrator of the group runs its membership and
          reads the rest. The server enforces the same split. */}
      {canManageGroups ? (
        <>
          <label htmlFor="group-name" style={{ marginTop: '0.75rem', marginBottom: '0.25rem' }}>
            <span className="field-label">Name</span>
          </label>
          <div className="row">
            <input
              id="group-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && renamed && onRename(name.trim())}
              style={{ flex: 1 }}
            />
            <button type="button" onClick={() => onRename(name.trim())} disabled={busy || !renamed}>
              Save name
            </button>
          </div>
        </>
      ) : null}

      <h4>Members can</h4>
      <p className="muted" style={{ fontSize: '0.82rem', marginTop: 0 }}>
        Applies to surveys this group owns.
        {canManageGroups ? '' : ' Only a super administrator can change this.'}
      </p>
      {catalogue.map((entry) => (
        <label className="option-row" key={entry.key}>
          <input
            type="checkbox"
            checked={group.memberPermissions.includes(entry.key)}
            disabled={busy || !canManageGroups}
            onChange={() => onTogglePermission(entry.key)}
          />
          <span>
            {entry.label}
            <br />
            <span className="muted" style={{ fontSize: '0.8rem' }}>
              {entry.detail}
            </span>
          </span>
        </label>
      ))}

      <h4>Members</h4>
      {group.members.length === 0 ? (
        <p className="muted" style={{ fontSize: '0.85rem', marginTop: 0 }}>
          No members yet.
        </p>
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
                  {member.administers ? (
                    <span className="badge" style={{ marginLeft: '0.5rem' }}>
                      Administers this group
                    </span>
                  ) : null}
                </th>
                <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                  {/* Administering is a property of THIS membership: it says
                      nothing about any other group they belong to. A super
                      admin bypasses groups, so it is never offered for them. */}
                  {member.tier === 'super_admin' ? null : (
                    <>
                      <button
                        type="button"
                        onClick={() => onSetMemberAdmin(member, !member.administers)}
                        disabled={busy}
                      >
                        {member.administers ? 'Remove as admin' : 'Make group admin'}
                      </button>{' '}
                    </>
                  )}
                  <button
                    type="button"
                    className="danger"
                    onClick={() => setRemoving(member)}
                    disabled={busy}
                    aria-label={`Remove ${member.displayName || member.username} from ${group.name}`}
                  >
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
          value={memberId}
          aria-label={`Add an admin to ${group.name}`}
          onChange={(e) => setMemberId(e.target.value)}
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
          disabled={busy || !memberId}
          onClick={async () => {
            await onAddMember(memberId, memberIsAdmin);
            setMemberId('');
            setMemberIsAdmin(false);
          }}
        >
          Add
        </button>
      </div>
      <label className="option-row">
        <input
          type="checkbox"
          checked={memberIsAdmin}
          disabled={busy}
          onChange={(e) => setMemberIsAdmin(e.target.checked)}
        />
        <span>
          As an administrator of {group.name}
          <br />
          <span className="muted" style={{ fontSize: '0.8rem' }}>
            They run this group&rsquo;s membership: who is in it, and who else administers it. Only
            a super administrator can make somebody an administrator of more than one group.
          </span>
        </span>
      </label>
      {group.members.some((member) => member.tier === 'super_admin') ? (
        <p className="muted" style={{ fontSize: '0.8rem' }}>
          Super administrators already have every permission everywhere; membership does not change
          what they can do.
        </p>
      ) : null}

      {removing ? (
        <div className="confirm">
          <h3>Remove {removing.displayName || removing.username} from {group.name}?</h3>
          <ul>
            <li>They lose whatever {group.name} lets its members do to its surveys.</li>
            {removing.administers ? (
              <li>They no longer administer {group.name} or run its membership.</li>
            ) : null}
            <li>
              Their account is kept, along with every other group they are in. This removes the
              membership only.
            </li>
          </ul>
          <div className="row">
            {/* Cancel first and confirm last, so the destructive control is
                neither the nearest nor the one focus lands on. */}
            <button type="button" onClick={() => setRemoving(null)}>
              Cancel
            </button>
            <button
              type="button"
              className="danger"
              onClick={() => {
                onRemoveMember(removing);
                setRemoving(null);
              }}
            >
              Remove {removing.displayName || removing.username}
            </button>
          </div>
        </div>
      ) : null}

      {confirming ? (
        <div className="confirm">
          <h3>Delete this group?</h3>
          <p>
            Its surveys will be reassigned to the default group, and its members and grants removed.
            This cannot be undone.
          </p>
          <div className="row">
            <button type="button" onClick={() => setConfirming(false)}>
              Cancel
            </button>
            <button type="button" className="danger" onClick={onDelete}>
              Delete &ldquo;{group.name}&rdquo;
            </button>
          </div>
        </div>
      ) : null}
    </section>
  );
}

/**
 * The grants that already exist, one line each.
 *
 * Only pairs that actually hold a grant appear, so this is as long as the
 * access really is rather than as long as the group count squared.
 *
 * @param {{rows: object[], catalogue: object[], busy: boolean,
 *   onEdit: (row: object) => void, onRemove: (row: object) => void}} props
 * @returns {JSX.Element} The list, or an empty state.
 */
function GrantList({ rows, catalogue, busy, onEdit, onRemove }) {
  if (rows.length === 0) {
    return <p className="empty">No group has access to another group&rsquo;s surveys yet.</p>;
  }

  return (
    <ul className="grant-list">
      {rows.map((row) => (
        <li className="grant-row" key={`${row.sourceId}:${row.targetId}`}>
          <span className="grant-pair">
            <strong>{row.sourceName}</strong> <span className="muted">can access</span>{' '}
            <strong>{row.targetName}</strong>
          </span>
          <span className="grant-perms muted">
            {permissionNames(catalogue, row.permissions).join(', ')}
          </span>
          <span className="grant-actions">
            <button
              type="button"
              onClick={() => onEdit(row)}
              aria-label={`Edit ${row.sourceName}'s access to ${row.targetName}`}
            >
              Edit
            </button>
            <button
              type="button"
              className="danger"
              disabled={busy}
              onClick={() => onRemove(row)}
              aria-label={`Remove ${row.sourceName}'s access to ${row.targetName}`}
            >
              Remove
            </button>
          </span>
        </li>
      ))}
    </ul>
  );
}

/**
 * Group management.
 *
 * A group decides what its members may do to its own surveys, and can be given
 * permissions over another group's surveys. The default group is renamable but
 * cannot be deleted, and there is always exactly one.
 *
 * Two audiences. A super admin shapes the groups themselves: creating them,
 * renaming them, deciding what their members may do, and granting one group
 * access to another. An administrator of a group runs that group's membership
 * and only that: the server sends them their own groups alone, and everything
 * outside membership is read-only here as well as refused there.
 *
 * The page is two sections, each reading left to right. The first picks one
 * group and shows only that group's controls; the second is a single sentence
 * that grants one group access to another, over a list of the grants that
 * exist. Nothing else is expanded, so the page grows with the number of groups
 * rather than with the number of pairs of groups.
 *
 * Every change is saved immediately and the list reloaded, so what is shown is
 * always what the server holds.
 *
 * @returns {JSX.Element} The page.
 */
export function AdminGroups() {
  const [data, setData] = useState(null);
  const [selectedId, setSelectedId] = useState(null);
  const [name, setName] = useState('');
  // The one pair being granted or edited in section 2.
  const [grant, setGrant] = useState({ sourceId: '', targetId: '', permissions: [] });
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

  if (!data) {
    return (
      <div className="shell">
        {error ? <div className="error">{error}</div> : <p className="muted">Loading...</p>}
      </div>
    );
  }

  const { groups, admins, catalogue } = data;
  const canManageGroups = Boolean(data.canManageGroups);
  // The selection is derived rather than stored, so deleting the selected group
  // falls back to the default instead of leaving the pane pointing at nothing.
  const selected =
    groups.find((group) => group.id === selectedId) ??
    groups.find((group) => group.isDefault) ??
    groups[0] ??
    null;

  const existing = findGrant(groups, grant.sourceId, grant.targetId);
  const grantRows = listGrants(groups);

  /** Creates a group and selects it. */
  const create = () =>
    run(async () => {
      const created = await api('/admin/groups', { method: 'POST', body: { name: name.trim() } });
      setName('');
      if (created?.id) setSelectedId(created.id);
    }, 'Group created.');

  /**
   * Renames the selected group.
   *
   * @param {string} next The new name.
   */
  const rename = (next) =>
    run(() => api(`/admin/groups/${selected.id}`, { method: 'PATCH', body: { name: next } }),
      'Group renamed.');

  /** Makes the selected group the default. */
  const makeDefault = () =>
    run(() => api(`/admin/groups/${selected.id}`, { method: 'PATCH', body: { isDefault: true } }),
      `${selected.name} is now the default group.`);

  /**
   * Toggles one of the selected group's member permissions.
   *
   * @param {string} key The permission key.
   */
  const toggleMemberPermission = (key) =>
    run(() =>
      api(`/admin/groups/${selected.id}`, {
        method: 'PATCH',
        body: { memberPermissions: togglePermission(selected.memberPermissions, key) },
      }),
    );

  /**
   * Adds an admin to the selected group, optionally to administer it.
   *
   * @param {string} userId The admin to add.
   * @param {boolean} isAdmin Whether the new membership administers the group.
   */
  const addMember = (userId, isAdmin) =>
    run(() =>
      api(`/admin/groups/${selected.id}/members`, { method: 'POST', body: { userId, isAdmin } }),
    );

  /**
   * Grants or revokes administration of the selected group to one member.
   *
   * Scoped to this group alone: it says nothing about any other group they
   * belong to, and the server refuses a caller who does not administer this one.
   *
   * @param {object} member The member being changed.
   * @param {boolean} isAdmin The standing to set.
   */
  const setMemberAdmin = (member, isAdmin) =>
    run(
      () =>
        api(`/admin/groups/${selected.id}/members/${member.id}`, {
          method: 'PATCH',
          body: { isAdmin },
        }),
      isAdmin
        ? `${member.displayName || member.username} now administers ${selected.name}.`
        : `${member.displayName || member.username} no longer administers ${selected.name}.`,
    );

  /**
   * Removes an admin from the selected group.
   *
   * @param {object} member The member to remove.
   */
  const removeMember = (member) =>
    run(
      () => api(`/admin/groups/${selected.id}/members/${member.id}`, { method: 'DELETE' }),
      `${member.displayName || member.username} is no longer in ${selected.name}.`,
    );

  /** Deletes the selected group, reassigning its surveys to the default. */
  const destroy = () => {
    const removedId = selected.id;
    return run(async () => {
      await api(`/admin/groups/${removedId}`, { method: 'DELETE' });
      setSelectedId(null);
      // Its grants cascade away with it, so drop it from the sentence row too
      // rather than leaving a select pointing at a group that is gone.
      setGrant((current) =>
        current.sourceId === removedId || current.targetId === removedId
          ? { sourceId: '', targetId: '', permissions: [] }
          : current,
      );
    }, `Removed ${selected.name}.`);
  };

  /**
   * Chooses the group being given access, loading whatever that pair already
   * holds so the same row edits as well as creates.
   *
   * @param {string} sourceId The source group.
   */
  const chooseSource = (sourceId) =>
    setGrant((current) => {
      // A group is never offered access to itself, so a target that has just
      // become the source is dropped.
      const targetId = current.targetId === sourceId ? '' : current.targetId;
      return { sourceId, targetId, permissions: findGrant(groups, sourceId, targetId) ?? [] };
    });

  /**
   * Chooses the group whose surveys are reached.
   *
   * @param {string} targetId The target group.
   */
  const chooseTarget = (targetId) =>
    setGrant((current) => ({
      ...current,
      targetId,
      permissions: findGrant(groups, current.sourceId, targetId) ?? [],
    }));

  /**
   * Writes the sentence row's pair. An empty permission list clears the grant,
   * which is how the API removes one.
   */
  const saveGrant = () =>
    run(
      () =>
        api(`/admin/groups/${grant.sourceId}/grants`, {
          method: 'PUT',
          body: { targetGroupId: grant.targetId, permissions: grant.permissions },
        }),
      grant.permissions.length === 0 ? 'Access removed.' : 'Access saved.',
    );

  /**
   * Clears one existing grant.
   *
   * @param {object} row The listed grant.
   */
  const removeGrant = (row) =>
    run(async () => {
      await api(`/admin/groups/${row.sourceId}/grants`, {
        method: 'PUT',
        body: { targetGroupId: row.targetId, permissions: [] },
      });
      // If that pair is loaded in the row above, empty it too rather than
      // leaving ticks for access that no longer exists.
      setGrant((current) =>
        current.sourceId === row.sourceId && current.targetId === row.targetId
          ? { ...current, permissions: [] }
          : current,
      );
    }, `${row.sourceName} no longer has access to ${row.targetName}.`);

  return (
    <div className="shell">
      <h1>Groups</h1>
      <p className="muted">
        A group decides what its members can do to its own surveys, and can be granted access to
        another group&rsquo;s surveys. Membership is explicit and works the same with or without
        Discord.
        {canManageGroups
          ? ''
          : ' You are shown the groups you administer: their membership is yours to run, and the rest is a super administrator’s.'}
      </p>

      {error ? <div className="error">{error}</div> : null}
      {status ? <p className="muted">{status}</p> : null}

      <div className="card">
        <h2>What a group can do</h2>
        <p className="muted" style={{ fontSize: '0.85rem' }}>
          Pick a group on the left. Everything on the right belongs to that group alone.
        </p>

        <div className="split">
          <div className="split-side">
            <GroupList groups={groups} selectedId={selected?.id} onSelect={setSelectedId} />
            {canManageGroups ? (
              <div className="row" style={{ marginTop: '0.75rem' }}>
                <input
                  type="text"
                  aria-label="New group name"
                  placeholder="New group name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && name.trim() && create()}
                  style={{ flex: 1, minWidth: '8rem' }}
                />
                <button type="button" className="primary" onClick={create} disabled={busy || !name.trim()}>
                  Create
                </button>
              </div>
            ) : null}
          </div>

          {selected ? (
            <GroupDetail
              key={selected.id}
              group={selected}
              admins={admins}
              catalogue={catalogue}
              busy={busy}
              canManageGroups={canManageGroups}
              onRename={rename}
              onMakeDefault={makeDefault}
              onDelete={destroy}
              onTogglePermission={toggleMemberPermission}
              onAddMember={addMember}
              onSetMemberAdmin={setMemberAdmin}
              onRemoveMember={removeMember}
            />
          ) : (
            <p className="empty split-main">
              {canManageGroups
                ? 'Create a group to get started.'
                : 'You do not administer a group yet.'}
            </p>
          )}
        </div>
      </div>

      {/* Reaching across groups is a deployment-shaping decision, so the whole
          section belongs to super admins. An administrator of one group has no
          business granting it rights over another. */}
      {!canManageGroups ? null : (
      <div className="card">
        <h2>Access between groups</h2>
        <p className="muted" style={{ fontSize: '0.85rem' }}>
          Read it as a sentence: one group can do these things to another group&rsquo;s surveys.
          Choosing a pair that already has access loads it here for editing.
        </p>

        {groups.length < 2 ? (
          <p className="empty">
            Access between groups needs a second group; there is only one so far.
          </p>
        ) : (
          <>
            <div className="sentence">
              <select
                className="sentence-select"
                aria-label="Group being given access"
                value={grant.sourceId}
                onChange={(e) => chooseSource(e.target.value)}
              >
                <option value="">Choose a group...</option>
                {groups.map((group) => (
                  <option key={group.id} value={group.id}>
                    {group.name}
                  </option>
                ))}
              </select>

              <span className="sentence-word">can</span>

              <div className="chip-set" role="group" aria-label="Permissions granted">
                {catalogue.map((entry) => {
                  const on = grant.permissions.includes(entry.key);
                  return (
                    <label className={on ? 'chip chip-on' : 'chip'} key={entry.key}>
                      <input
                        type="checkbox"
                        checked={on}
                        disabled={busy || !grant.sourceId || !grant.targetId}
                        onChange={() =>
                          setGrant((current) => ({
                            ...current,
                            permissions: togglePermission(current.permissions, entry.key),
                          }))
                        }
                      />
                      <span>{entry.label}</span>
                    </label>
                  );
                })}
              </div>

              <span className="sentence-word">on</span>

              <select
                className="sentence-select"
                aria-label="Group whose surveys are reached"
                value={grant.targetId}
                onChange={(e) => chooseTarget(e.target.value)}
              >
                <option value="">Choose a group...</option>
                {grantTargets(groups, grant.sourceId).map((group) => (
                  <option key={group.id} value={group.id}>
                    {group.name}
                  </option>
                ))}
              </select>

              <button
                type="button"
                className="primary"
                onClick={saveGrant}
                disabled={
                  busy ||
                  !grant.sourceId ||
                  !grant.targetId ||
                  (!existing && grant.permissions.length === 0)
                }
              >
                {existing ? 'Update' : 'Grant'}
              </button>
            </div>

            {existing && grant.permissions.length === 0 ? (
              <p className="muted" style={{ fontSize: '0.82rem' }}>
                Updating with nothing ticked removes this access.
              </p>
            ) : null}

            <h4>Access that exists</h4>
            <GrantList
              rows={grantRows}
              catalogue={catalogue}
              busy={busy}
              onEdit={(row) =>
                setGrant({
                  sourceId: row.sourceId,
                  targetId: row.targetId,
                  permissions: [...row.permissions],
                })
              }
              onRemove={removeGrant}
            />
          </>
        )}
      </div>
      )}
    </div>
  );
}
