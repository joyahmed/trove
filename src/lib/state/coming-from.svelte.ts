// "I'm coming from" (plan 19): which system's WORDS (Recycle Bin or Trash, Properties or Get
// Info, This PC / This Mac / This Computer) Trove uses. 'native' = the OS Trove runs on.
// ⛔ Style only. The host — the physical keyboard, paths, the real bin — stays `onMac()` /
// `onWindows()` in `platform.ts`. Two axes, never one boolean.
// ⛔ Imports only `platform-facts.ts`: importing `platform.ts` or `settings.svelte.ts` here
// would close an import cycle (settings → custom-commands → platform → here).
import { injected, type TrovePlatform } from '$lib/utils/platform-facts';

export type OsStyle = 'windows' | 'mac' | 'linux';
export type ComingFrom = 'native' | OsStyle;

/** localStorage key holding the last choice, so a new window paints the right words before its
 * settings are read. Written by `useComingFrom`. */
export const COMING_FROM_STORAGE_KEY = 'trove-coming-from';

/** The style of the OS Trove runs on. Nothing injected (tests, a plain browser) → Windows,
 * like every switch in `platform.ts`. */
export const hostStyle = (platform: TrovePlatform | undefined = injected()): OsStyle =>
  platform?.os === 'macos' ? 'mac' : platform?.os === 'linux' ? 'linux' : 'windows';

/** A stored value as a choice; anything else is 'native'. */
export const toChoice = (raw: unknown): ComingFrom =>
  raw === 'windows' || raw === 'mac' || raw === 'linux' ? raw : 'native';

/** The first-paint mirror; junk, nothing, or storage that throws → 'native'. */
export const readMirror = (): ComingFrom => {
  try {
    return toChoice(globalThis.localStorage?.getItem(COMING_FROM_STORAGE_KEY));
  } catch {
    return 'native';
  }
};

class ComingFromState {
  choice = $state<ComingFrom>(readMirror());

  /** The choice resolved: 'native' becomes the host's style, read at call time. */
  get style(): OsStyle {
    return this.choice === 'native' ? hostStyle() : this.choice;
  }
}

export const comingFrom = new ComingFromState();
