# Quorum

A self-hosted, privacy-focused survey tool. Respondents answer anonymously with no account at all; admins sign in with a username and password, optionally hardened with TOTP two-factor authentication. Surveys belong to groups, and a group decides both what its members may do and who may take its surveys; the Discord plugin adds Discord sign-in and lets a group be gated on server membership, roles, or channel access. It runs entirely on your own infrastructure and sends nothing to third parties.

Created by [Thomas Loupe](https://thomasloupe.com).

## Features

- **Anonymous responses** with no respondent accounts; local username/password sign-in for admins, with optional TOTP two-factor authentication.
- **Discord sign-in as a plugin** that verifies server membership; a group can be limited to specific roles or to members who can see a given channel, and every survey it owns inherits that.
- **Eight question types:** short and long text (with character limits), integer (min/max/step), single choice, multiple choice (with selection limits), ranking, true/false (with custom labels), scale, and file upload.
- **Privacy by design:** responses are pseudonymous by default, IP addresses are never stored, and every collection toggle is disclosed to the participant before they answer.
- **Results dashboards** with per-question charts (donuts and bars), a table view for every chart, colour-vision-safe palettes, and CSV/JSON export.
- **Admin panel** to create, schedule, open, close, and delete surveys, manage admins and the groups that decide what they can do, and connect Discord through a guided wizard.
- **Optional plugins:** Discord integration, two-factor authentication, Discord announcements, closing reminders, conditional question logic, response quotas, and a raffle picker.
- **Four skins** (Default, GitHub, Obsidian, High Contrast) in light and dark, remembered per account.
- **A public data-privacy page** that spells out exactly what a deployment can collect, why, and when it is anonymised.

## Quick start

1. `cp .env.example .env` and fill it in.
2. `docker compose up -d --build`
3. Find the one-time setup link in the logs: `docker compose logs api | grep setup`
4. Open it and create the first super administrator account (username + password). You are signed in immediately; surveys can be created and taken right away, no Discord required.

To add Discord sign-in and role/channel gating, enable the **Discord Integration** plugin under Admin, Plugins, and connect your server from its settings page. You will need a [Discord application](https://discord.com/developers/applications) with a redirect URL of `<PUBLIC_URL>/api/auth/callback`, and a bot invited to your server with the `View Channels` permission. The bot never posts unless you enable the announcements plugin (which then needs `Send Messages` in the chosen channel).

Requested OAuth scopes are kept to `identify` alone. The bot token is what makes channel gating, gate configuration, adding admins by user ID, and prompt access revocation possible, because Discord exposes no OAuth scope for a guild's channel overwrites or role permissions.

## Updating

The admin page shows a banner when a newer version is published. To update, run `./update.sh` from the folder holding your `docker-compose.yml` (or `docker compose pull && docker compose up -d`). New database migrations run automatically when the new version starts; your data volumes are untouched.

Releases are published to GHCR by a GitHub Action on each `v*` tag. To cut one: bump the version in `api/package.json` and `web/package.json`, then `git tag v1.2.3 && git push --tags`.

## Verifying a build

The footer shows the exact commit a build was compiled from, linked to its source. That is transparency, not a tamper seal: a server draws its own footer, so it can only report what it claims to be.

Every page has a footer badge linking to a **`/verify`** page. The running server resolves its own published image and reports whether its provenance is signed, and the page hands out the exact command to check it independently (a "Copy Attestation" button copies both). Enabled plugins are listed there too; a built-in plugin is database config and never affects the verdict, while any custom (unlisted) plugin is disclosed as outside the verified build. That in-app result is the server reporting on itself, which is an honest signal for a deployment you trust but not proof for one you do not.

The verifiable proof is on the published image. Each release carries a [Sigstore build-provenance attestation](https://docs.github.com/actions/security-guides/using-artifact-attestations-to-establish-provenance-for-builds) binding the image digest to this repo, this commit, and the workflow that built it. Anyone can check it, no GitHub account needed:

```
gh attestation verify oci://ghcr.io/thomasloupe/quorum-api:1.2.0 --repo thomasloupe/Quorum
gh attestation verify oci://ghcr.io/thomasloupe/quorum-web:1.2.0 --repo thomasloupe/Quorum
```

A pass proves the image was built by this repo's release workflow from that commit, not hand-built or swapped. It attests the published artifact, not any one operator's live container: an operator controls their own server, so no rendered badge can prove a running site is untampered. The guarantee lives on the image you pull, before it ever runs.

## Privacy model

- **Respondent identity is pseudonymous by default.** Each response stores `HMAC(per-survey key, pepper + respondent id)`, where the respondent id is a random value in a signed browser cookie; a signed-in account is only linked when the survey has "record username" enabled. The key is per survey, so responses cannot be correlated across surveys.
- **Rotating a survey's respondent key permanently detaches its responses from their authors.** This is the deletion primitive.
- **IP addresses are never stored.** Country, when collected, is resolved in-process at submit time and only the two-letter code is kept.
- **Every collection toggle is disclosed to the participant** on the survey intro screen before they answer anything.
- **No third-party requests.** A strict Content-Security-Policy allows only the site's own origin and Discord's CDN for avatars.
- **Stored Discord credentials and 2FA secrets are encrypted at rest** with a key derived from `SESSION_SECRET`.

## Admins

Two tiers:

- **Super administrator:** unrestricted. Manages other admins, promotes further super admins, and configures sign-in and plugins. Bypasses groups entirely. The first one is created by the one-time setup link.
- **Administrator:** whatever their groups allow, and nothing of their own.

**Groups are where permissions live.** A survey belongs to one or more groups, and a group says what its members may do to the surveys it owns: create/edit, open/close, delete, and view results/export. Holding a permission over any one of a survey's groups covers that survey, because each of them owns it as fully as the others. A group can also be granted some of those over another group's surveys. All of it is edited on the Groups page; an account itself holds only its tier and its membership.

A group also decides **who may take** its surveys — see [Survey audiences](#survey-audiences).

**There is no default group.** An administrator who belongs to no group can do nothing at all, so every route that could produce one refuses instead: creating an admin requires a group, removing somebody's last group is refused, and demoting a super administrator requires a destination group. A super administrator is the mirror image — they reach every group without belonging to any, so they hold no membership at all, cannot be added to a group, and lose any membership they held when promoted. Admins granted by a Discord role or channel are the one kind nobody creates, so the Discord plugin names the group they resolve against; with none named they get no access rather than a guessed one.

**Group administrators** run one group's membership. The standing belongs to the membership, not to the account: an administrator of Selections who also belongs to Astro administers Selections and nothing else. Within a group they administer they can invite somebody into it, add an existing admin to it, make another member an administrator of that same group, and remove a member from it — the membership only, never the account, and never their last group. They cannot create, rename or delete groups, change what any group's members may do or who may take its surveys, grant one group access to another, reach plugins or deployment settings, or make anybody a super administrator. Only a super administrator can make somebody an administrator of more than one group. Super administrator and group administrator are exclusive: a super admin bypasses groups, so the one excludes the other in both directions.

Admins are local accounts (created with a one-time password shown once), or Discord members granted by user id when that plugin is connected. Either is put in a group as they are created — a required choice, with nothing preselected — and may be marked as an administrator of it at the same time, which is the same thing the Groups page does. A plain administrator never sees that super administrators exist. Admins can also be granted by a Discord role or channel chosen in the Discord plugin settings; those grant the administrator tier, never super administrator. You cannot remove your own access, and the last super administrator cannot be removed.

## Survey audiences

Who may **take** a survey is a property of the groups it belongs to, not of the survey itself. A group is either tied to the connected Discord server or it is not:

- Not tied — the default — means truly anonymous. No sign-in, no Discord call, and the role and channel lists are never read.
- Tied means the respondent signs in with Discord and must be a member of the server. If the group also names roles or channels they must match: any one of the roles, any one of the channels, and both lists when both are populated.

A respondent may take a survey when they satisfy **at least one** of its groups. The same survey placed on Astro, Gaming and a wide-open "Public" group is takeable by anyone; on Astro and Gaming alone it is takeable by whoever qualifies under either. Refusals never say which role or channel would have granted access.

A group with no bounds is how a survey reaches everybody: make one whose members create for the general public, and place the survey there. Respondents only see the surveys they qualify for, by the same rule.

**One person is one account.** Where the Discord plugin is connected, an admin holds both identities: a local username and password, and a linked Discord id. Both are asked for once, as a single "finish setting up your account" flow with a fixed order, and a step already satisfied is skipped. Signing in with a Discord account nobody has linked creates nothing; it says so and points at the sign-in form, because accounts exist for administrators and respondents need none. Linking runs over the same OAuth redirect URL as signing in, and a Discord id already held by another account is refused rather than moved. Anyone can unlink their own Discord from Settings, and a super admin can unlink somebody else's from the Users tab, except where that would leave an account with no way to sign in at all.

## Plugins

Each plugin has a global on/off switch and cannot be disabled while an open survey depends on it.

- **Discord Integration:** Discord sign-in, role/channel group gates, the group that role- and channel-granted admins land in, granting admins by Discord user id, and the bot transport the announcement plugins post through.
- **Two-Factor Authentication:** TOTP codes for admin sign-in (QR code or manual secret entry); super admins can require it per account.
- **Discord Announcements:** post to a channel when a survey opens or closes, with an aggregate result summary on close.
- **Reminders & Nudges:** post a "closing soon" reminder before a scheduled close.
- **Conditional Logic:** show or skip questions based on an earlier answer.
- **Response Quotas:** automatically close a survey once it reaches a target number of responses.
- **Raffle Picker:** draw a random completed respondent, revealing only what the survey already recorded.

## Stack

Node 22 + Express API, React SPA (Vite + Recharts), PostgreSQL 17, all behind nginx in Docker Compose.

```
api/            Express API
  src/lib/      Answer validation, timing, crypto, passwords, plugin catalogue, settings
  src/db/       Pool, migrations, migration runner
  src/routes/   Auth, setup, participant, admin
  src/plugins/  discord (client, gates, permission maths, OAuth, wizard), twofactor (TOTP)
web/            React SPA
  src/charts/   Validated palette and the result charts
  src/pages/    Survey taking, admin panel, plugin settings, privacy
```

## Tests

```
cd api && npm test
```

Covers group permission resolution across a survey's groups, the guild gate and the union across them, what an admin account may consist of and who may change one, what removing an admin costs, how a group's three populations are counted, Discord permission resolution, Discord account linking and the OAuth intent it is carried by, the forced-onboarding order, answer validation, response timing, result aggregation, file-upload validation, password hashing, and TOTP (against the RFC 4226/6238 vectors). Migrations are checked for the rules they carry, since the backfills are what keep an existing deployment behaving as it did.

## Notes

Discord has no "who is in a channel" endpoint. The channel gate resolves a member's roles against the channel's permission overwrites, reproducing Discord's own calculation, including administrator bypass, owner bypass, member-specific overwrites, and thread inheritance.

`docker-compose.preview.yml` is a local-development convenience that bypasses sign-in. It only activates under `NODE_ENV=development` and the process refuses to start if that flag is set with any other environment, so it can never be enabled by accident on a real deployment.

## License

Source-available under the [PolyForm Perimeter License 1.0.0](LICENSE.md). Use, modify, and self-host Quorum for any purpose, including running a business on it, free of charge. You may not resell, repackage, or offer it as a product or hosted service that competes with Quorum.
