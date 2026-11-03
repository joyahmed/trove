// The system accent and transparency setting, read once on mount. The accent is applied only when
// Settings → Appearance → Accent colour is "Match system" (Windows only; see use-shell); otherwise
// the app's own sapphire `--color-accent` (src/app.css) stands.
// ⚠️ `transparency` is reported and nothing acts on it — see `core/theme.rs`. No window asks for
// `windowEffects` on Windows any more, so the chrome colour is unconditional there; the class this used to toggle
// painted `body`, which propagated to the viewport canvas and cancelled the rounded window frame.
// Also the light/dark theme: Settings → Appearance → Theme picks System, Light or Dark, and
// `resolved` is what `<html data-theme>` carries (hooks/use-theme sets it; app.css switches the
// tokens on it). System follows the OS's `prefers-color-scheme`, live.
import { systemTheme } from '$lib/api/theme';
import { logError } from '$lib/api/log';
import { settings, type ThemeChoice } from '$lib/state/settings.svelte';

/** The theme actually shown: the choice, with System answered by the OS. */
export const resolveTheme = (choice: ThemeChoice, systemDark: boolean): 'light' | 'dark' =>
  choice === 'system' ? (systemDark ? 'dark' : 'light') : choice;

const DARK_QUERY = '(prefers-color-scheme: dark)';
/** The OS's answer right now; light where there is no `matchMedia` (tests). */
export const prefersDark = (): boolean =>
  typeof matchMedia === 'function' && matchMedia(DARK_QUERY).matches;

/** Call `cb` whenever the OS switches light/dark; returns the unsubscribe. */
export const watchSystemDark = (cb: (dark: boolean) => void): (() => void) => {
  if (typeof matchMedia !== 'function') return () => {};
  const mq = matchMedia(DARK_QUERY);
  const on = (e: MediaQueryListEvent) => cb(e.matches);
  mq.addEventListener('change', on);
  return () => mq.removeEventListener('change', on);
};

/** The token's own default (src/app.css), used until the OS answers or when it cannot. */
export const DEFAULT_ACCENT = '#2f4bd0';

class ThemeState {
  accent = $state(DEFAULT_ACCENT);
  /** Settings → Personalization → Colors → Transparency effects. Dormant: nothing reads it. */
  transparency = $state(true);
  /** Windows' text size factor; seeds the UI zoom on the first run */
  textScale = $state(1);
  loaded = $state(false);
  /** the OS is in dark mode — kept live by hooks/use-theme */
  systemDark = $state(prefersDark());
  /** light or dark, as shown: the Theme setting with System resolved */
  resolved = $derived(resolveTheme(settings.theme, this.systemDark));
  dark = $derived(this.resolved === 'dark');

  async load() {
    try {
      const t = await systemTheme();
      if (/^#[0-9a-f]{6}$/i.test(t.accent)) this.accent = t.accent;
      this.transparency = t.transparency;
      if (Number.isFinite(t.textScale) && t.textScale >= 1 && t.textScale <= 2.25) {
        this.textScale = t.textScale;
      }
    } catch (e) {
      logError('theme.load', e);
      // keep the defaults; the tokens are Windows 11's own
    }
    this.loaded = true;
  }
}

export const theme = new ThemeState();
