// The light/dark theme's reactivity: keeps `theme.systemDark` live with the OS and writes the
// resolved theme onto `<html data-theme="light|dark">`, where app.css switches the tokens.
// Called once from the root layout, so every window — explorer and Spotlight — follows it.
// On a Mac it also sets the explorer window's own appearance, because the frosted glass behind
// the page (the `sidebar` material) follows the WINDOW's appearance, not our tokens: without it,
// Trove Light on a Mac in Dark mode shows dark glass under light chrome.
import { logError } from '$lib/api/log';
import { setNativeTheme, windowLabel } from '$lib/api/window';
import { settings, type ThemeChoice } from '$lib/state/settings.svelte';
import { prefersDark, theme, watchSystemDark } from '$lib/state/theme.svelte';

/** localStorage key the inline script in app.html reads before the first paint; holds the choice. */
export const THEME_STORAGE_KEY = 'trove-theme';

/** Explorer windows (`main`, `main-<n>`, as Rust's `is_explorer_label`) — the ones with glass and the set-theme permission. */
export const isExplorerLabel = (label: string) => /^main(-\d+)?$/.test(label);

/** The appearance to force on the window: the resolved theme for Light/Dark, `null` (the
 * system's) for System. */
export const nativeThemeFor = (
  choice: ThemeChoice,
  resolved: 'light' | 'dark',
): 'light' | 'dark' | null => (choice === 'system' ? null : resolved);

/** True only in a Mac explorer window. Off a Mac the window API is never touched. */
const macExplorer = (): boolean => {
  if (document.documentElement.dataset.os !== 'macos') return false;
  try {
    return isExplorerLabel(windowLabel());
  } catch {
    return false; // no Tauri runtime (a plain browser)
  }
};

/** One sync of the window's appearance to the setting; a no-op off a Mac explorer window and
 * before settings are read. Exported for the test: `$effect` does not run in the node suite. */
export const syncNativeTheme = async (mac: boolean) => {
  if (!mac || !settings.settled) return;
  const target = nativeThemeFor(settings.theme, theme.resolved);
  try {
    await setNativeTheme(target);
    // back on the system appearance: the media query is the OS's again
    if (target === null) theme.systemDark = prefersDark();
  } catch (e) {
    logError('theme.setNativeTheme', e);
  }
};

/** The OS switching light/dark, as `prefers-color-scheme` reports it.
 * ⚠️ On a Mac that query follows the WINDOW's appearance, which `syncNativeTheme` forces while
 * the choice is Light or Dark — those changes are our own echo, not the OS, so they are dropped
 * and `systemDark` keeps the real answer. Going back to System re-reads it. */
export const onSystemDark = (mac: boolean, dark: boolean) => {
  if (mac && settings.theme !== 'system') return;
  theme.systemDark = dark;
};

const applyTheme = (resolved: 'light' | 'dark', choice: ThemeChoice, settled: boolean) => {
  // ⚠️ Nothing before this window's settings are the person's (`settings.settled`): until then
  // the choice is System's guess, and applying it would flash the OS theme over the stored one
  // that app.html's inline script already painted (a Ctrl+N window), then flip. Storing it would
  // also overwrite a real Light/Dark choice the next window paints on its first frame.
  if (!settled) return;
  document.documentElement.dataset.theme = resolved;
  // The CHOICE, not the resolved colour: app.html resolves System itself on the next window's
  // first frame, so an OS flip between launches still paints right.
  try {
    localStorage.setItem(THEME_STORAGE_KEY, choice);
  } catch {
    // storage blocked: that window falls back to the OS answer
  }
};

export const useTheme = () => {
  const mac = macExplorer();

  // Before settings load nothing is applied: app.html's inline script has painted the stored theme.
  applyTheme(theme.resolved, settings.theme, settings.settled);

  $effect(() => watchSystemDark((dark) => onSystemDark(mac, dark)));

  $effect(() => applyTheme(theme.resolved, settings.theme, settings.settled));

  // tracks settings.theme, settings.settled and theme.resolved (read synchronously inside)
  $effect(() => void syncNativeTheme(mac));
};
