# Quorum

A self-hosted, privacy-focused survey tool for a Discord community. Members sign in with Discord, and surveys are gated on server membership, roles, or channel access. It runs entirely on your own infrastructure and sends nothing to third parties.

Created by [Thomas Loupe](https://thomasloupe.com).

## Features

- **Discord sign-in** that verifies server membership; surveys can be limited to specific roles or to members who can see a given channel.
- **Eight question types:** short and long text (with character limits), integer (min/max/step), single choice, multiple choice (with selection limits), ranking, true/false (with custom labels), scale, and file upload.
- **Privacy by design:** responses are pseudonymous by default, IP addresses are never stored, and every collection toggle is disclosed to the participant before they answer.
- **Results dashboards** with per-question charts (donuts and bars), a table view for every chart, colour-vision-safe palettes, and CSV/JSON export.
- **Admin panel** to create, schedule, open, close, and delete surveys, manage admins with granular permissions, and configure everything through a guided Discord setup wizard.
- **Optional plugins:** Discord announcements, closing reminders, conditional question logic, response quotas, and a raffle picker.
- **Four skins** (Default, GitHub, Obsidian, High Contrast) in light and dark, remembered per account.
- **A public data-privacy page** that spells out exactly what a deployment can collect, why, and when it is anonymised.

## Quick start

1. `cp .env.example .env` and fill it in. Discord credentials do **not** go here.
2. `docker compose up -d --build`
3. Find the one-time setup link in the logs: `docker compose logs api | grep setup`
4. Open it and connect your Discord server. The wizard verifies the credentials against Discord before saving them.
5. Sign in with Discord when prompted. That account becomes the first super administrator.

You will need a [Discord application](https://discord.com/developers/applications) with a redirect URL of `<PUBLIC_URL>/api/auth/callback`, and a bot invited to your server with the `View Channels` permission. The bot never posts unless you enable the announcements plugin (which then needs `Send Messages` in the chosen channel).

Requested OAuth scopes are kept to `identify` alone. The bot token is what makes channel gating, gate configuration, adding admins by user ID, and prompt access revocation possible, because Discord exposes no OAuth scope for a guild's channel overwrites or role permissions.

## Updating

The admin page shows a banner when a newer version is published. To update, run `./update.sh` from the folder holding your `docker-compose.yml` (or `docker compose pull && docker compose up -d`). New database migrations run automatically when the new version starts; your data volumes are untouched.

Releases are published to GHCR by a GitHub Action on each `v*` tag. To cut one: bump the version in `api/package.json` and `web/package.json`, then `git tag v1.2.3 && git push --tags`.

## Verifying a build

The footer shows the exact commit a build was compiled from, linked to its source. That is transparency, not a tamper seal: a server draws its own footer, so it can only report what it claims to be.

The verifiable proof is on the published image. Each release carries a [Sigstore build-provenance attestation](https://docs.github.com/actions/security-guides/using-artifact-attestations-to-establish-provenance-for-builds) binding the image digest to this repo, this commit, and the workflow that built it. Anyone can check it:

```
gh attestation verify oci://ghcr.io/thomasloupe/quorum-api:1.0.1 --repo thomasloupe/Quorum
gh attestation verify oci://ghcr.io/thomasloupe/quorum-web:1.0.1 --repo thomasloupe/Quorum
```

A pass proves the image was built by this repo's release workflow from that commit, not hand-built or swapped. It attests the published artifact, not any one operator's live container: an operator controls their own server, so no rendered badge can prove a running site is untampered. The guarantee lives on the image you pull, before it ever runs.

## Privacy model

- **Respondent identity is pseudonymous by default.** Each response stores `HMAC(per-survey key, pepper + discord_id)`, never the raw id, unless the survey has "record username" enabled. The key is per survey, so responses cannot be correlated across surveys.
- **Rotating a survey's respondent key permanently detaches its responses from their authors.** This is the deletion primitive.
- **IP addresses are never stored.** Country, when collected, is resolved in-process at submit time and only the two-letter code is kept.
- **Every collection toggle is disclosed to the participant** on the survey intro screen before they answer anything.
- **No third-party requests.** A strict Content-Security-Policy allows only the site's own origin and Discord's CDN for avatars.
- **Stored Discord credentials are encrypted at rest** with a key derived from `SESSION_SECRET`.

## Admins

Two tiers:

- **Super administrator:** unrestricted. Manages other admins, promotes further super admins, and re-runs setup. The first one is whoever completes setup and signs in.
- **Administrator:** only the permissions granted: create/edit surveys, open/close surveys, delete surveys, and view results/export.

A plain administrator never sees that super administrators exist. Admins can also be granted by a Discord role or channel chosen during setup; those grant the administrator tier, never super administrator. You cannot remove your own access, and the last super administrator cannot be removed.

## Plugins

Each plugin has a global on/off switch and cannot be disabled while an open survey depends on it.

- **Discord Announcements:** post to a channel when a survey opens or closes, with an aggregate result summary on close.
- **Reminders & Nudges:** post a "closing soon" reminder before a scheduled close.
- **Conditional Logic:** show or skip questions based on an earlier answer.
- **Response Quotas:** automatically close a survey once it reaches a target number of responses.
- **Raffle Picker:** draw a random completed respondent, revealing only what the survey already recorded.

## Stack

Node 22 + Express API, React SPA (Vite + Recharts), PostgreSQL 17, all behind nginx in Docker Compose.

```
api/            Express API
  src/lib/      Discord client, permission maths, answer validation, gating, timing, crypto, plugins
  src/db/       Pool, migrations, migration runner
  src/routes/   Auth, setup, participant, admin
web/            React SPA
  src/charts/   Validated palette and the result charts
  src/pages/    Survey taking, admin panel, setup wizard, plugins, privacy
```

## Tests

```
cd api && npm test
```

Covers Discord permission resolution, answer validation, response timing, result aggregation, and file-upload validation.

## Notes

Discord has no "who is in a channel" endpoint. The channel gate resolves a member's roles against the channel's permission overwrites, reproducing Discord's own calculation, including administrator bypass, owner bypass, member-specific overwrites, and thread inheritance.

`docker-compose.preview.yml` is a local-development convenience that bypasses Discord sign-in. It only activates under `NODE_ENV=development` and the process refuses to start if that flag is set with any other environment, so it can never be enabled by accident on a real deployment.

## License

Source-available under the [PolyForm Perimeter License 1.0.0](LICENSE.md). Use, modify, and self-host Quorum for any purpose, including running a business on it, free of charge. You may not resell, repackage, or offer it as a product or hosted service that competes with Quorum.
