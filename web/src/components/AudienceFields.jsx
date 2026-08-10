import { Toggle } from './Toggle.jsx';

/**
 * Who may take a group's surveys.
 *
 * This used to sit on the survey, one copy per survey. It belongs to the group:
 * a group is a set of people and the surveys it runs for them, so "who can take
 * our surveys" is answered once, by the group, and every survey it owns
 * inherits it. A survey placed in several groups is takeable by anyone who
 * satisfies any one of them.
 *
 * The shape of the decision is unchanged. One question first - is this for the
 * server or for anyone - and only then the narrowing, so the two are never
 * mistaken for unrelated settings.
 *
 * @param {object} props
 * @param {string} props.groupName The group being edited, for the copy.
 * @param {{requireGuild: boolean, gateRoleIds: string[], gateChannelIds: string[]}} props.value
 *   The audience as stored.
 * @param {(patch: object) => void} props.onChange Applies one change.
 * @param {{roles: object[], channels: object[]}} props.discord The server's
 *   roles and channels, empty until they arrive.
 * @param {boolean} props.ready Whether a Discord server is connected at all.
 * @param {string} props.serverName What to call the connected server.
 * @param {boolean} props.disabled Whether the caller may change any of it.
 * @returns {JSX.Element} The section.
 */
export function AudienceFields({
  groupName,
  value,
  onChange,
  discord,
  ready,
  serverName,
  disabled = false,
}) {
  const roleIds = value.gateRoleIds ?? [];
  const channelIds = value.gateChannelIds ?? [];

  // Gated with nothing left to check it against. The toggle stays so this is a
  // decision that can still be reversed from here.
  if (!ready) {
    return value.requireGuild ? (
      <>
        <div className="error">
          {groupName} is limited to the members of a Discord server, and no server is connected, so
          nobody can take its surveys. Connect one under Admin, Plugins, or turn the limit off here.
        </div>
        <Toggle
          checked
          disabled={disabled}
          onChange={(requireGuild) => onChange({ requireGuild })}
          label="Only members of a Discord server can take this group's surveys"
        />
      </>
    ) : (
      <p className="muted" style={{ marginBottom: 0 }}>
        Anyone with the link, anonymously. Limiting a group to the members of a Discord server
        needs the Discord Integration plugin enabled with a server connected.
      </p>
    );
  }

  return (
    <>
      <Toggle
        checked={!!value.requireGuild}
        disabled={disabled}
        onChange={(requireGuild) => onChange({ requireGuild })}
        label={`Only members of ${serverName} can take ${groupName}'s surveys`}
        hint="Participants sign in with Discord and their membership is checked before the survey opens. Left off, this group's surveys are truly anonymous: no sign-in, and Discord is never contacted."
      />

      {value.requireGuild ? (
        <>
          <p className="muted" style={{ fontSize: '0.85rem', marginTop: '1rem' }}>
            Optionally narrow it further to who <strong>from {serverName}</strong> may take them.
            Leave both lists empty and every member can.
          </p>

          <label>
            <span className="field-label">Roles (any one of these)</span>
            <select
              multiple
              disabled={disabled}
              size={Math.min(8, Math.max(3, discord.roles.length))}
              value={roleIds}
              onChange={(e) =>
                onChange({ gateRoleIds: [...e.target.selectedOptions].map((o) => o.value) })
              }
            >
              {discord.roles.map((role) => (
                <option key={role.id} value={role.id}>
                  {role.name}
                </option>
              ))}
            </select>
          </label>

          <label>
            <span className="field-label">Channels (can see any one of these)</span>
            <select
              multiple
              disabled={disabled}
              size={Math.min(8, Math.max(3, discord.channels.length))}
              value={channelIds}
              onChange={(e) =>
                onChange({ gateChannelIds: [...e.target.selectedOptions].map((o) => o.value) })
              }
            >
              {discord.channels.map((channel) => (
                <option key={channel.id} value={channel.id}>
                  #{channel.name}
                </option>
              ))}
            </select>
          </label>

          {/* Both lists populated is an AND, which is narrower than it looks
              and the easiest way to lock everyone out. Say so plainly. */}
          {roleIds.length > 0 && channelIds.length > 0 ? (
            <div className="confirm">
              <h3>Both requirements must be met</h3>
              <p style={{ marginBottom: 0 }}>
                A member needs one of the {roleIds.length} selected role
                {roleIds.length === 1 ? '' : 's'} <strong>and</strong> must be able to see one of
                the {channelIds.length} selected channel{channelIds.length === 1 ? '' : 's'}.
                Anyone missing either is refused.
              </p>
            </div>
          ) : null}
        </>
      ) : null}
    </>
  );
}
