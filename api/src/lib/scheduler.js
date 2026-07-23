import { config } from '../config.js';
import { query } from '../db/pool.js';
import * as discord from './discord.js';
import { PLUGINS, isPluginEnabled } from './plugins.js';
import { current } from './settings.js';

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
  if (!isPluginEnabled(current().plugins, PLUGINS.REMINDERS)) return;

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
      await discord.postMessage(
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
 * Starts the periodic reminder sweep.
 *
 * @returns {NodeJS.Timeout} The interval handle, for shutdown.
 */
export function startScheduler() {
  const run = () =>
    runReminders().catch((error) => console.warn('Reminder sweep failed:', error.message));

  setTimeout(run, 30_000);
  return setInterval(run, 5 * 60_000);
}
