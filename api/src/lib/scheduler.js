import { config } from '../config.js';
import { query } from '../db/pool.js';
import { PLUGINS, isPluginEnabled } from './plugins.js';
import { current } from './settings.js';
import { postMessage } from '../plugins/discord/discord.js';
import { isDue } from './autoUpdate.js';
import { applyUpdate, autoUpdateState, pullUpdate } from './selfUpdate.js';

/**
 * Posts "closing soon" reminders for surveys whose window is nearly up.
 *
 * Runs on a timer rather than per-request because it fires on the passage of
 * time, not on any user action. Each survey is reminded at most once, tracked
 * by `reminder_sent`, which resets whenever the survey is reopened.
 *
 * @returns {Promise<void>}
 */
export async function runReminders() {
  const settings = current();
  if (!isPluginEnabled(settings.plugins, PLUGINS.REMINDERS)) return;
  // Posting is the discord plugin's transport; without it there is nowhere to
  // post, whatever the reminder configuration says.
  if (!isPluginEnabled(settings.plugins, PLUGINS.DISCORD) || !settings.discord.configured) return;

  const { rows } = await query(
    `SELECT id, slug, title, plugin_config
       FROM surveys
      WHERE status = 'open'
        AND reminder_sent = false
        AND closes_at IS NOT NULL
        AND closes_at > now()
        AND (opens_at IS NULL OR opens_at <= now())
        AND plugin_config ? 'remindHoursBeforeClose'
        AND plugin_config->>'announceChannelId' IS NOT NULL
        AND closes_at <= now()
            + ((plugin_config->>'remindHoursBeforeClose') || ' hours')::interval`,
  );

  for (const survey of rows) {
    try {
      const url = `${config.publicUrl}/s/${survey.slug}`;
      const hours = survey.plugin_config.remindHoursBeforeClose;
      await postMessage(
        survey.plugin_config.announceChannelId,
        `**Reminder: ${survey.title} closes soon**\n` +
          `Closing within ${hours} hour(s). Take it here: ${url}`,
      );
      await query('UPDATE surveys SET reminder_sent = true WHERE id = $1', [survey.id]);
    } catch (error) {
      console.warn(`Reminder for survey ${survey.id} failed: ${error.message}`);
    }
  }
}

/**
 * Downloads a new version when the schedule says it is time, and restarts into
 * it only if the deployment asked for that separately.
 *
 * The sweep runs every five minutes; the schedule decides whether anything
 * happens, so the interval an administrator sets is honoured to within one
 * sweep rather than being a second timer to keep in step with this one.
 *
 * @returns {Promise<void>}
 */
export async function runAutoUpdate() {
  const state = await autoUpdateState();
  if (!isDue(state, Date.now())) return;

  const pulled = await pullUpdate();
  if (pulled.status !== 'downloaded') return;

  console.log(`Downloaded Quorum ${pulled.version}.`);
  if (!state.restart) {
    console.log('Auto-restart is off; it will be applied when an administrator asks.');
    return;
  }

  // From here the updater container stops this process, so nothing after the
  // call is guaranteed to run. Everything worth recording is already recorded.
  const applied = await applyUpdate(pulled.version);
  if (applied.status !== 'restarting') {
    console.warn(`Restart into ${pulled.version} did not start: ${applied.message ?? applied.status}`);
  }
}

/**
 * Starts the periodic sweeps.
 *
 * @returns {NodeJS.Timeout} The interval handle, for shutdown.
 */
export function startScheduler() {
  const run = () => {
    runReminders().catch((error) => console.warn('Reminder sweep failed:', error.message));
    runAutoUpdate().catch((error) => console.warn('Auto-update sweep failed:', error.message));
  };

  setTimeout(run, 30_000);
  return setInterval(run, 5 * 60_000);
}
