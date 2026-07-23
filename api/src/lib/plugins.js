/**
 * Plugin catalogue and enablement.
 *
 * Each plugin has a global on/off switch stored in app_settings.plugins. A
 * plugin that is off is inert everywhere: its per-survey settings are ignored
 * and its hooks do nothing.
 */

export const PLUGINS = {
  ANNOUNCEMENTS: 'announcements',
  REMINDERS: 'reminders',
  CONDITIONAL: 'conditional',
  QUOTAS: 'quotas',
  RAFFLE: 'raffle',
};

/** Display metadata, shared with the frontend through the API. */
export const PLUGIN_CATALOGUE = [
  {
    key: PLUGINS.ANNOUNCEMENTS,
    name: 'Discord Announcements',
    detail:
      'Post to a chosen channel when a survey opens or closes, with a short summary of the results on close. The bot needs the Send Messages permission in that channel.',
  },
  {
    key: PLUGINS.REMINDERS,
    name: 'Reminders & Nudges',
    detail:
      'Post a reminder to the announcement channel before a scheduled survey closes, so members have a chance to take part.',
  },
  {
    key: PLUGINS.CONDITIONAL,
    name: 'Conditional Logic',
    detail: 'Show or skip questions based on how an earlier question was answered.',
  },
  {
    key: PLUGINS.QUOTAS,
    name: 'Response Quotas',
    detail: 'Automatically close a survey once it reaches a target number of completed responses.',
  },
  {
    key: PLUGINS.RAFFLE,
    name: 'Raffle Picker',
    detail:
      'Draw a random completed respondent as a winner, revealing only what the survey already recorded.',
  },
];

const PLUGIN_KEYS = new Set(PLUGIN_CATALOGUE.map((plugin) => plugin.key));

/**
 * Whether a plugin is globally enabled.
 *
 * @param {object} plugins The app_settings.plugins map.
 * @param {string} key A plugin key.
 * @returns {boolean} True when enabled.
 */
export function isPluginEnabled(plugins, key) {
  return Boolean(plugins?.[key]);
}

/**
 * Filters a submitted enablement map to known plugin keys.
 *
 * @param {*} input Whatever the client sent.
 * @returns {object} A clean { key: boolean } map.
 */
export function sanitisePlugins(input) {
  const out = {};
  if (input && typeof input === 'object') {
    for (const key of PLUGIN_KEYS) out[key] = Boolean(input[key]);
  }
  return out;
}
