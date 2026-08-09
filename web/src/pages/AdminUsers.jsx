import { Fragment, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { removalConsequences } from '../lib/removal.js';

/**
 * Admin access management.
 *
 * An admin account is a standing and a set of groups. Super administrators are
 * unrestricted and bypass groups; everybody else does what their groups allow.
 * One of those memberships may also administer its group, which is a property
 * of that membership: an administrator of Selections who also belongs to Astro
 * administers Selections alone.
 *
 * Who may use this page, and to what extent, follows from that. A super admin
 * manages every account. An administrator of a group may invite people, but
 * only into a group they administer - which the page states rather than
 * defaults to - and the server settles it again regardless. Membership itself
 * is edited on the Groups page and nowhere else, so the two can never disagree.
 *
 * @returns {JSX.Element|null} The card, or null before the list loads.
 */
export function AdminUsers() {
  const [data, setData] = useState(null);
  const [mode, setMode] = useState('local');
  const [username, setUsername] = useState('');
  const [discordId, setDiscordId] = useState('');
  const [superAdmin, setSuperAdmin] = useState(false);
  const [groupAdmin, setGroupAdmin] = useState(false);
  const [groupId, setGroupId] = useState('');
  const [editing, setEditing] = useState(null);
  const [removing, setRemoving] = useState(null);
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
      .then((next) => {
        setData(next);
        // The groups offered are the ones the caller may invite into: every
        // group for a super admin, and only their own for an administrator of
        // one. Re-derived on each load so a group that has gone away does not
        // leave the field pointing at nothing.
        setGroupId((current) =>
          next.groups?.some((group) => group.id === current)
            ? current
            : next.groups?.[0]?.id ?? '',
        );
      })
      .catch((e) => setError(e.message));

  useEffect(() => {
    load();
  }, []);

  /** Creates a local admin, or grants access to a Discord member. */
  const add = async () => {
    setBusy(true);
    setError(null);
    setStatus(null);
    setOneTime(null);
    try {
      // Super admins bypass groups, so one is never sent for them. The two
      // standings are exclusive; the server refuses both regardless.
      const body = {
        superAdmin,
        groupAdmin,
        groupId: superAdmin ? null : groupId || null,
      };
      if (mode === 'discord') {
        const result = await api('/plugin/discord/admins', {
          method: 'POST',
          body: { ...body, discordId: discordId.trim() },
        });
        setStatus(`${result.username} now has access.`);
        setDiscordId('');
      } else {
        const result = await api('/admin/admins', {
          method: 'POST',
          body: { ...body, username: username.trim() },
        });
        setOneTime({ username: result.username, password: result.password });
        setUsername('');
      }
      setSuperAdmin(false);
      setGroupAdmin(false);
      await load();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  /**
   * Saves a changed standing for an existing admin.
   *
   * @param {object} admin The admin being edited.
   */
  const save = async (admin) => {
    setError(null);
    try {
      await api(`/admin/admins/${admin.id}`, {
        method: 'PATCH',
        body: { superAdmin: editing.superAdmin },
      });
      setEditing(null);
      setStatus(`Updated ${admin.username}.`);
      await load();
    } catch (e) {
      setError(e.message);
    }
  };

  /**
   * Revokes all access, once confirmed.
   *
   * @param {object} admin The admin being removed.
   */
  const remove = async (admin) => {
    setError(null);
    try {
      await api(`/admin/admins/${admin.id}`, { method: 'DELETE' });
      setRemoving(null);
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
   * Unlinks an admin's Discord identity.
   *
   * The server refuses when the account has no password, since that would
   * leave it with no way to sign in at all.
   *
   * @param {object} admin The admin being unlinked.
   */
  const unlinkDiscord = async (admin) => {
    setError(null);
    setStatus(null);
    try {
      await api(`/plugin/discord/link/${admin.id}`, { method: 'DELETE' });
      setStatus(
        `Discord unlinked from ${admin.username}. They are asked to link again on their next request.`,
      );
      await load();
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
  const canInvite = data.canInvite;
  const discordOn = Boolean(data.plugins?.discord);
  const twofactorOn = Boolean(data.plugins?.twofactor);
  const groups = data.groups ?? [];
  const defaultGroupName = groups.find((group) => group.isDefault)?.name ?? 'the default group';
  // A single group is not a choice, so it is stated rather than selected: the
  // page has to read as "you are inviting somebody into <group>".
  const fixedGroup = !canManage && groups.length === 1 ? groups[0] : null;

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

      {canInvite ? (
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

          {/* Exactly one of the two, or neither. Ticking one greys the other
              out; the server refuses a body carrying both either way. Only a
              super admin can make another, so the box is theirs alone. */}
          {canManage ? (
            <label className="option-row">
              <input
                type="checkbox"
                checked={superAdmin}
                disabled={groupAdmin}
                onChange={(e) => setSuperAdmin(e.target.checked)}
              />
              <span>
                Super administrator
                <br />
                <span className="muted" style={{ fontSize: '0.82rem' }}>
                  Everything, including managing admins and plugins. Bypasses groups.
                </span>
              </span>
            </label>
          ) : null}

          <label className="option-row">
            <input
              type="checkbox"
              checked={groupAdmin}
              disabled={superAdmin}
              onChange={(e) => setGroupAdmin(e.target.checked)}
            />
            <span>
              Group administrator
              <br />
              <span className="muted" style={{ fontSize: '0.82rem' }}>
                Runs the membership of the group below, and that group only: who is in it, and who
                else administers it.
              </span>
            </span>
          </label>

          {/* A plain admin can do whatever their group can do, so the group is
              the whole of the decision. Super admins bypass groups, so it is
              not offered for them. */}
          {superAdmin || groups.length === 0 ? null : (
            <div style={{ marginLeft: '1.6rem' }}>
              {fixedGroup ? (
                <p style={{ margin: '0 0 0.25rem' }}>
                  <span className="field-label">Group</span>
                  <br />
                  Inviting into <strong>{fixedGroup.name}</strong>, the group you administer.
                </p>
              ) : (
                <>
                  <label htmlFor="new-admin-group" style={{ marginBottom: '0.25rem' }}>
                    <span className="field-label">
                      {canManage ? 'Group' : 'Group you are inviting them into'}
                    </span>
                  </label>
                  <select
                    id="new-admin-group"
                    value={groupId}
                    onChange={(e) => setGroupId(e.target.value)}
                    style={{ minWidth: '12rem' }}
                  >
                    {groups.map((group) => (
                      <option key={group.id} value={group.id}>
                        {group.name}
                        {group.isDefault && canManage ? ' (default)' : ''}
                      </option>
                    ))}
                  </select>
                </>
              )}
              <p className="muted" style={{ fontSize: '0.8rem' }}>
                What they can do is whatever this group can do to its own surveys. Membership is
                changed on the <Link to="/admin/groups">Groups</Link> page.
              </p>
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
          </tr>
        </thead>
        <tbody>
          {data.granted.map((admin) => (
            <Fragment key={admin.id}>
            <tr>
              <th scope="row" style={{ display: 'table-cell' }}>
                {admin.displayName || admin.username}
                {admin.isSelf ? (
                  <span className="badge" style={{ marginLeft: '0.5rem' }}>You</span>
                ) : null}
                <br />
                {/* Both identities are shown separately: an account is meant to
                    hold each of them, so "which one is missing" is the useful
                    fact rather than "which kind of account is this". */}
                <span className="muted" style={{ fontSize: '0.8rem' }}>
                  Password: {admin.local ? 'set' : 'not set'}
                  {discordOn ? (
                    <>
                      <br />
                      Discord: {admin.discordId ?? 'not linked'}
                    </>
                  ) : null}
                </span>
              </th>
              <td>
                {admin.tier === 'super_admin' ? (
                  <span className="badge">Super administrator</span>
                ) : (
                  <>
                    {/* Being a group administrator is only meaningful together
                        with which group, so the two are never shown apart. */}
                    {admin.administers.length > 0 ? (
                      <>
                        <span className="badge">Group administrator</span>{' '}
                        <span className="muted" style={{ fontSize: '0.82rem' }}>
                          of {admin.administers.join(', ')}
                        </span>
                        <br />
                      </>
                    ) : null}
                    <span className="muted" style={{ fontSize: '0.82rem' }}>
                      {/* Membership is the access. An admin in no group falls
                          back to the default one, said outright rather than
                          shown as a blank. */}
                      {admin.groups.length > 0
                        ? `In ${admin.groups.map((group) => group.name).join(', ')}`
                        : `No group - ${defaultGroupName} applies`}
                    </span>
                  </>
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
            </tr>
            {/* The actions live on their own full-width row rather than in a
                third column: four buttons cannot share a row with the account
                details without running past the edge of the page. */}
            {canManage ? (
              <tr className="row-actions">
                <td colSpan={2}>
                  {admin.isSelf ? (
                    <span className="muted" style={{ fontSize: '0.8rem' }}>Ask another admin</span>
                  ) : (
                    <div className="row-buttons">
                      <button
                        type="button"
                        onClick={() =>
                          setEditing(
                            editing?.id === admin.id
                              ? null
                              : {
                                  id: admin.id,
                                  superAdmin: admin.tier === 'super_admin',
                                  administers: admin.administers,
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
                      {discordOn && admin.discordId ? (
                        <>
                          <button type="button" onClick={() => unlinkDiscord(admin)}>
                            Unlink Discord
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
                      <button
                        type="button"
                        className="danger"
                        onClick={() => {
                          setError(null);
                          setStatus(null);
                          setRemoving(admin);
                        }}
                      >
                        Remove
                      </button>
                    </div>
                  )}
                </td>
              </tr>
            ) : null}
            </Fragment>
          ))}

          {data.adminRoles.map((role) => (
            <tr key={role.id}>
              <th scope="row" style={{ display: 'table-cell' }}>
                Anyone with <strong>{role.name}</strong>
              </th>
              <td>
                <span className="muted" style={{ fontSize: '0.82rem' }}>
                  Discord role - administrator, not super admin
                  <br />
                  In no group, so {defaultGroupName} applies until they are added to one.
                  {canManage ? (
                    <>
                      <br />
                      Change this in the Discord plugin settings.
                    </>
                  ) : null}
                </span>
              </td>
            </tr>
          ))}

          {data.adminChannels.map((channel) => (
            <tr key={channel.id}>
              <th scope="row" style={{ display: 'table-cell' }}>
                Anyone who can see <strong>#{channel.name}</strong>
              </th>
              <td>
                <span className="muted" style={{ fontSize: '0.82rem' }}>
                  Discord channel - administrator, not super admin
                  <br />
                  In no group, so {defaultGroupName} applies until they are added to one.
                  {canManage ? (
                    <>
                      <br />
                      Change this in the Discord plugin settings.
                    </>
                  ) : null}
                </span>
              </td>
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
            </tr>
          ))}
        </tbody>
      </table>

      <p className="muted" style={{ fontSize: '0.8rem' }}>
        Who is in which group, and who administers it, is edited on the{' '}
        <Link to="/admin/groups">Groups</Link> page.
      </p>

      {removing ? (
        <div className="confirm">
          <h3>Remove {removing.displayName || removing.username}?</h3>
          <ul>
            {removalConsequences(removing).map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
          <div className="row">
            {/* Cancel first and confirm last, so the destructive control is
                neither the nearest nor the one focus lands on. */}
            <button type="button" onClick={() => setRemoving(null)}>
              Cancel
            </button>
            <button type="button" className="danger" onClick={() => remove(removing)}>
              Remove {removing.displayName || removing.username}
            </button>
          </div>
        </div>
      ) : null}

      {editing ? (
        <div className="confirm" style={{ borderLeftColor: 'var(--accent)' }}>
          <h3 style={{ color: 'var(--text-primary)' }}>Change access</h3>
          <label className="option-row">
            <input
              type="checkbox"
              checked={editing.superAdmin}
              // A group administrator cannot also be a super admin, so the box
              // is unavailable until their group standing is cleared. The
              // server refuses the promotion for the same reason.
              disabled={editing.administers.length > 0}
              onChange={(e) => setEditing({ ...editing, superAdmin: e.target.checked })}
            />
            <span>
              Super administrator
              <br />
              <span className="muted" style={{ fontSize: '0.82rem' }}>
                {editing.administers.length > 0
                  ? `They administer ${editing.administers.join(', ')}. Clear that on the Groups page first: a super administrator bypasses groups.`
                  : 'The only standing held by the account itself. Everything else follows from its groups.'}
              </span>
            </span>
          </label>
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
