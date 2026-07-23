/**
 * Categorical palette for result charts.
 *
 * Both columns are validated as a set against their own surface: worst adjacent
 * CVD separation 9.1 light / 8.4 dark, worst adjacent normal-vision separation
 * 19.6 light / 19.3 dark. The dark column is the same eight hues re-stepped for
 * the dark surface, not an automatic inversion of the light one.
 *
 * Three light-mode slots fall below 3:1 against the light surface, so every
 * chart built on this palette ships direct labels and a table view rather than
 * relying on colour alone.
 */

export const SERIES_LIGHT = [
  '#2a78d6', // blue
  '#008300', // green
  '#e87ba4', // magenta
  '#eda100', // yellow
  '#1baf7a', // aqua
  '#eb6834', // orange
  '#4a3aa7', // violet
  '#e34948', // red
];

export const SERIES_DARK = [
  '#3987e5',
  '#008300',
  '#d55181',
  '#c98500',
  '#199e70',
  '#d95926',
  '#9085e9',
  '#e66767',
];

/** Neutral used for the folded "Other" bucket, which carries no identity. */
export const OTHER_COLOR = { light: '#8a8981', dark: '#6f6e67' };

/**
 * Largest number of slices a donut may show before it stops being readable.
 *
 * Past this the chart falls back to a horizontal bar list, where many
 * categories stay comparable.
 */
export const MAX_DONUT_SLICES = 6;

/**
 * Number of categories kept before the remainder is folded into "Other".
 *
 * The palette has eight slots and hues are never cycled, so a ninth category
 * would otherwise reuse a colour that already means something else.
 */
export const MAX_CATEGORIES = 8;

/**
 * Reads the palette for the currently active theme.
 *
 * @param {boolean} dark Whether the dark theme is active.
 * @returns {{series: string[], other: string}} Hex values for this theme.
 */
export function paletteFor(dark) {
  return {
    series: dark ? SERIES_DARK : SERIES_LIGHT,
    other: dark ? OTHER_COLOR.dark : OTHER_COLOR.light,
  };
}

/**
 * Folds a long category list down to what the palette can express.
 *
 * Categories arrive sorted by count; everything past the cutoff is summed into
 * a single neutral "Other" entry so no hue is reused.
 *
 * @param {Array<{key: string, label: string, count: number}>} categories
 * @param {number} limit Maximum categories to keep before folding.
 * @returns {Array<{key: string, label: string, count: number, folded?: boolean}>}
 *   Categories with an "Other" entry appended when folding occurred.
 */
export function foldCategories(categories, limit = MAX_CATEGORIES) {
  if (categories.length <= limit) return categories;

  const kept = categories.slice(0, limit - 1);
  const rest = categories.slice(limit - 1);
  const total = rest.reduce((sum, category) => sum + category.count, 0);

  return [
    ...kept,
    { key: '__other__', label: `Other (${rest.length} answers)`, count: total, folded: true },
  ];
}
