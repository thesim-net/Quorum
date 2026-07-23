import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

/**
 * The available skins. Each one renders in both light and dark mode, so the
 * appearance is a skin plus a mode rather than a single flat theme.
 */
export const SKINS = [
  { id: 'default', label: 'Default' },
  { id: 'github', label: 'GitHub' },
  { id: 'obsidian', label: 'Obsidian' },
  { id: 'high-contrast', label: 'High Contrast' },
];

const SKIN_IDS = new Set(SKINS.map((skin) => skin.id));
const SKIN_KEY = 'quorum-skin';
const MODE_KEY = 'quorum-mode';

const ThemeContext = createContext({
  skin: 'default',
  mode: 'light',
  dark: false,
  setSkin: () => {},
  toggleMode: () => {},
  skins: SKINS,
});

/**
 * Resolves the mode to start in.
 *
 * @returns {'light'|'dark'} A stored choice, or the OS preference.
 */
function initialMode() {
  const stored = localStorage.getItem(MODE_KEY);
  if (stored === 'light' || stored === 'dark') return stored;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

/**
 * Resolves the skin to start in.
 *
 * @returns {string} A stored skin id, or the default.
 */
function initialSkin() {
  const stored = localStorage.getItem(SKIN_KEY);
  return stored && SKIN_IDS.has(stored) ? stored : 'default';
}

/**
 * Provides the active skin and mode, stamping both on the document root.
 *
 * The CSS keys every appearance off `data-skin` and `data-mode`, and charts
 * read `dark` to pick the palette stepped for that surface brightness.
 *
 * @param {{children: React.ReactNode}} props
 * @returns {JSX.Element} The provider.
 */
export function ThemeProvider({ children }) {
  const [skin, setSkinState] = useState(initialSkin);
  const [mode, setMode] = useState(initialMode);

  useEffect(() => {
    document.documentElement.dataset.skin = skin;
    document.documentElement.dataset.mode = mode;
    localStorage.setItem(SKIN_KEY, skin);
    localStorage.setItem(MODE_KEY, mode);
  }, [skin, mode]);

  /**
   * Selects a skin, ignoring an unknown id.
   *
   * @param {string} id A skin id from SKINS.
   */
  const setSkin = useCallback((id) => {
    if (SKIN_IDS.has(id)) setSkinState(id);
  }, []);

  const toggleMode = useCallback(() => {
    setMode((current) => (current === 'dark' ? 'light' : 'dark'));
  }, []);

  /**
   * Sets the mode explicitly, ignoring an unknown value.
   *
   * Used to apply a preference loaded from the server on sign-in.
   *
   * @param {'light'|'dark'} next The mode to apply.
   */
  const applyMode = useCallback((next) => {
    if (next === 'light' || next === 'dark') setMode(next);
  }, []);

  const value = useMemo(
    () => ({ skin, mode, dark: mode === 'dark', setSkin, toggleMode, applyMode, skins: SKINS }),
    [skin, mode, setSkin, toggleMode, applyMode],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

/**
 * Reads the active skin and mode.
 *
 * @returns {{skin: string, mode: string, dark: boolean, setSkin: (id: string) => void,
 *   toggleMode: () => void, skins: Array<{id: string, label: string}>}} Theme state.
 */
export const useTheme = () => useContext(ThemeContext);
