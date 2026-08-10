import { Fragment, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { removalConsequences } from '../lib/removal.js';

/**
 * Admin access management.
 *
 * An admin account is a standing and a set of groups. Super administrators are
 * unrestricted and bypass groups entirely - they hold no membership at all, and
 * one cannot be given to them. Everybody else does what their groups allow, and
 * nothing without one: there is no default group behind an administrator who
 * belongs to none, so a group is chosen here or the account is not created.
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
        // one. Nothing is preselected where there is a choice - picking one is
        // the decision, and a preselection would make the commonest choice the
        // one nobody looked at. The single exception is an administrator of
        // exactly one group, for whom there is no choice to make and the page
        // states the group rather than offering it.
        const offered = next.groups ?? [];
        setGroupId((current) => {
          if (offered.some((group) => group.id === current)) return current;
          return !next.canManage && offered.length === 1 ? offered[0].id : '';
        });
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
      // Super admins bypass groups, so one is never sent for them - the server
      // refuses a body carrying both rather than creating a membership it would
      // then have to delete. For everybody else the group is mandatory, and the
      // server refuses a body without one.
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
        // Coming down from super administrator lands them in no group at all,
        // which is no access at all, so a destination is sent with it. The
        // server refuses the demotion without one either way.
        body: { superAdmin: editing.superAdmin, groupId: editing.groupId || null },
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
  // Where a Discord role or channel lands somebody, when the plugin has been
  // told. Null means those accounts get no access at all, which the rows below
  // say outright rather than implying a default that no longer exists.
  const derivedGroup = data.discordAdminGroup ?? null;
  // A single group is not a choice, so it is stated rather than selected: the
  // page has to read as "you are inviting somebody into <group>".
  const fixedGroup = !canManage && groups.length === 1 ? groups[0] : null;
  // A group is mandatory for anybody but a super administrator, so the Add
  // button waits for one rather than letting the server refuse the round trip.
  const groupMissing = !superAdmin && !groupId;

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
              disabled={
                busy ||
                groupMissing ||
                (mode === 'discord' && discordOn ? !discordId.trim() : !username.trim())
              }
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
              the whole of the decision - and required, because an administrator
              in no group can do nothing at all. Super admins bypass groups, so
              it is not offered for them. */}
          {superAdmin ? null : (
            <div style={{ marginLeft: '1.6rem' }}>
              {groups.length === 0 ? (
                <div className="error">
                  There is no group to put them in, and an administrator in no group has no access
                  at all. Create a group on the <Link to="/admin/groups">Groups</Link> page first.
                </div>
              ) : fixedGroup ? (
                <p style={{ margin: '0 0 0.25rem' }}>
                  <span className="field-label">Group</span>
                  <br />
                  Inviting into <strong>{fixedGroup.name}</strong>, the group you administer.
                </p>
              ) : (
                <>
                  <label htmlFor="new-admin-group" style={{ marginBottom: '0.25rem' }}>
                    <span className="field-label">
                      {canManage ? 'Group (required)' : 'Group you are inviting them into'}
                    </span>
                  </label>
                  <select
                    id="new-admin-group"
                    value={groupId}
                    onChange={(e) => setGroupId(e.target.value)}
                    style={{ minWidth: '12rem' }}
                  >
                    <option value="">Choose a group...</option>
                    {groups.map((group) => (
                      <option key={group.id} value={group.id}>
                        {group.name}
                      </option>
                    ))}
                  </select>
                </>
              )}
              <p className="muted" style={{ fontSize: '0.8rem' }}>
                What they can do is whatever this group can do to its own surveys, and an
                administrator in no group can do nothing, so one has to be chosen. Membership is
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
                      {/* Membership IS the access. There is no default group
                          behind an admin who belongs to none, so "no group"
                          means no access - said outright rather than shown as
                          a blank that reads like an oversight. */}
                      {admin.groups.length > 0
                        ? `In ${admin.groups.map((group) => group.name).join(', ')}`
                        : 'No group, so no access. Add them to one on the Groups page.'}
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
                                  wasSuperAdmin: admin.tier === 'super_admin',
                                  superAdmin: admin.tier === 'super_admin',
                                  administers: admin.administers,
                                  groupId: '',
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

          {/* Nobody creates these accounts and nobody picks a group for them:
              the tier comes from a Discord role or channel, resolved per
              request. The Discord plugin names the group they resolve against,
              and with none named they have no access - which is what these rows
              have to say, since there is no default group behind them. */}
          {[
            ...data.adminRoles.map((role) => ({
              key: `role-${role.id}`,
              who: (
                <>
                  Anyone with <strong>{role.name}</strong>
                </>
              ),
              source: 'Discord role',
            })),
            ...data.adminChannels.map((channel) => ({
              key: `channel-${channel.id}`,
              who: (
                <>
                  Anyone who can see <strong>#{channel.name}</strong>
                </>
              ),
              source: 'Discord channel',
            })),
          ].map((entry) => (
            <tr key={entry.key}>
              <th scope="row" style={{ display: 'table-cell' }}>
                {entry.who}
              </th>
              <td>
                <span className="muted" style={{ fontSize: '0.82rem' }}>
                  {entry.source} - administrator, not super admin
                  <br />
                  {derivedGroup ? (
                    <>Resolved against <strong>{derivedGroup.name}</strong>.</>
                  ) : (
                    <>
                      No group is set for Discord-granted admins, so they have no access at all.
                      Set one in the Discord plugin settings.
                    </>
                  )}
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
                  : 'The only standing held by the account itself. Everything else follows from its groups. Granting it clears every group they belong to, since a super administrator reaches all of them anyway.'}
              </span>
            </span>
          </label>

          {/* A super administrator holds no memberships, so demoting one leaves
              them in no group - which is no access at all. Where they land is
              part of the demotion rather than something to fix afterwards. */}
          {editing.wasSuperAdmin && !editing.superAdmin ? (
            <div style={{ marginLeft: '1.6rem' }}>
              <label htmlFor="demote-group" style={{ marginBottom: '0.25rem' }}>
                <span className="field-label">Group they will belong to (required)</span>
              </label>
              <select
                id="demote-group"
                value={editing.groupId}
                onChange={(e) => setEditing({ ...editing, groupId: e.target.value })}
                style={{ minWidth: '12rem' }}
              >
                <option value="">Choose a group...</option>
                {groups.map((group) => (
                  <option key={group.id} value={group.id}>
                    {group.name}
                  </option>
                ))}
              </select>
              <p className="muted" style={{ fontSize: '0.8rem' }}>
                They hold no group membership as a super administrator, so without one they would
                reach the panel and be able to do nothing in it.
              </p>
            </div>
          ) : null}

          <div className="row">
            <button type="button" onClick={() => setEditing(null)}>
              Cancel
            </button>
            <button
              type="button"
              className="primary"
              disabled={editing.wasSuperAdmin && !editing.superAdmin && !editing.groupId}
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
