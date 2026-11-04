// The only place the Spotlight commands and the `spotlight:*` events appear. Two sides use
// it: the palette window (show/hide/resize, lookups, emitting what the explorer should do)
// and the main window (registering the chord, listening for what the palette asked).
// Mirrors src-tauri/src/commands/spotlight.rs.
import { invoke } from '@tauri-apps/api/core';
import { emit, listen } from '@tauri-apps/api/event';
import { openUrl } from '$lib/api/fs';
import type { FileEntry } from '$lib/types/fs';
import type { AppEntry } from '$lib/types/palette';

// ── main window ────────────────────────────────────────────────────────────
/**
 * Register the chord; rejects with a message when another app owns it. Resolves to a note when
 * it registered but the desktop also binds it (GNOME's Alt+Space window menu, D.5.2), else null.
 */
export const registerHotkey = (chord?: string) =>
  invoke<string | null>('register_hotkey', { chord });
/**
 * Tell Rust a shortcut recorder started or stopped. While it records, Windows' Alt+Space window
 * menu is held back and the registered chord stops opening Spotlight; either press arrives as
 * `onRecordedChord` instead (src-tauri/src/core/key_menu.rs, A.8.9). Never rejects: outside
 * Tauri, or on a failed call, the recorder still records whatever the page sees.
 */
export const setHotkeyRecordingNative = (on: boolean) =>
  invoke<void>('set_hotkey_recording', { on }).catch(() => undefined);
/** A chord the page could not see as a keydown, taken for the listening recorder. */
export const onRecordedChord = (cb: (chord: string) => void) =>
  listen<string>('hotkey-recorder:chord', (e) => cb(e.payload));
export const onHotkeyFailed = (cb: (message: string) => void) =>
  listen<string>('spotlight:hotkey-failed', (e) => cb(e.payload));
/** The palette asked the explorer to run one of `data/palette-actions.ts` by key. */
export const onSpotlightAction = (cb: (key: string) => void) =>
  listen<{ key: string }>('spotlight:action', (e) => cb(e.payload.key));
/** The palette asked the explorer to show a folder. */
export const onSpotlightNavigate = (cb: (path: string) => void) =>
  listen<{ path: string }>('spotlight:navigate', (e) => cb(e.payload.path));
/** The palette asked the explorer to show a file's folder with the file selected. */
export const onSpotlightReveal = (cb: (path: string) => void) =>
  listen<{ path: string }>('spotlight:reveal', (e) => cb(e.payload.path));
/** The palette asked the explorer to search every drive for `text` (its "Search everywhere"). */
export const onSpotlightSearch = (cb: (text: string, here: boolean) => void) =>
  listen<{ text: string; here?: boolean }>('spotlight:search', (e) =>
    cb(e.payload.text, e.payload.here === true),
  );
/**
 * An external open the palette attempted and could not do — no default browser association,
 * most plausibly. The palette window has its own JS realm, so it cannot reach the explorer's
 * `actions.notify` directly; this is the only way the person sees that Enter did nothing.
 */
export const onSpotlightOpenFailed = (cb: (message: string) => void) =>
  listen<{ message: string }>('spotlight:open-failed', (e) => cb(e.payload.message));

// ── palette window ─────────────────────────────────────────────────────────
export const onPaletteShown = (cb: () => void) => listen('spotlight:shown', () => cb());
export const hidePalette = () => invoke<void>('hide_palette');
export const resizePalette = (height: number) => invoke<void>('resize_palette', { height });
/** Bring the explorer window to the front before handing it a navigation. */
export const showMain = () => invoke<void>('show_main');
export const spotlightApps = (refresh = false) => invoke<AppEntry[]>('spotlight_apps', { refresh });
/**
 * Start an app that has no `.lnk` — every Store app, and the ID-list-only shortcuts whose
 * target `parse_lnk` cannot resolve. `shell:AppsFolder\<aumid>` is a shell namespace path, so
 * `openPath` cannot start it; only `ShellExecuteW` can, which is what this command wraps.
 */
export const launchApp = (aumid: string) => invoke<void>('launch_app', { aumid });
/**
 * The file hits, and (Mac) the privacy-guarded folders the search left out because the person
 * has not opened them in Trove yet — Desktop, Documents… in that order (`core::privacy_folders`).
 */
export type FoundFiles = { entries: FileEntry[]; skippedGuarded: string[] };
/** A bounded name search: ≤ maxResults, three levels deep, within budgetMs. */
export const spotlightFiles = (
  text: string,
  roots: string[],
  maxResults = 20,
  budgetMs = 300,
  maxDepth = 3,
) => invoke<FoundFiles>('spotlight_files', { text, roots, maxResults, budgetMs, maxDepth });
/** A root still on its first index walk: `label` is `home` or a drive (`D:`), `seen` names so far. */
export type IndexFilling = { label: string; seen: number };
/**
 * Trove's own name index (plan 21C): the best `maxResults` names under `roots`, ranked, from
 * memory. `ready: false` while no root has finished its first walk — search the old way then.
 * `filling` names the roots still walking (absent from answers older than plan 21C.2a).
 */
export type IndexAnswer = {
  ready: boolean;
  roots: string[];
  hits: FileEntry[];
  total: number;
  filling?: IndexFilling[];
  /** Roots served from their saved file and not caught up yet (absent before plan 21C.3). */
  stale?: string[];
  /** Mac: the unopened guarded folders under `roots`, whose names the index does not hold. */
  skippedGuarded?: string[];
};
export const indexSearch = (text: string, maxResults = 20) =>
  invoke<IndexAnswer>('index_search', { text, maxResults });
/** The roots still on their first index walk, for the palette footer to ask again. */
export const indexProgress = () => invoke<IndexFilling[]>('index_progress');
/**
 * Bring the index's WSL snapshots up to date for `distros`, the ones seen running. Returns at
 * once; Rust lists only a distro `wsl.exe` also reports running, so a stopped one never boots.
 */
export const indexWsl = (distros: string[]) => invoke<void>('index_wsl', { distros });
export const emitAction = (key: string) => emit('spotlight:action', { key });
export const emitNavigate = (path: string) => emit('spotlight:navigate', { path });
export const emitReveal = (path: string) => emit('spotlight:reveal', { path });
export const emitSearch = (text: string, here = false) => emit('spotlight:search', { text, here });
export const emitOpenFailed = (message: string) => emit('spotlight:open-failed', { message });

/**
 * Enter on a row that opens a URL: hand it to the OS, then get out of the way.
 *
 * ⛔ The failure is the whole point. `open_url` rejects on a machine with no `https`
 * association, and the palette's usual failure shape (`catch { return [] }`) would mean
 * pressing Enter does nothing, forever, with no message — the silent-failure class that cost
 * this app three regressions on 2026-09-26. So a rejection is shown, never swallowed.
 *
 * ⭐ `showMain()` runs only on failure, not before the open. Its whole reason is that a toast
 * raised behind a hidden or tray-resident explorer is a toast nobody sees — which is only true
 * when there IS a toast. On the success path the browser is the window that should take the
 * foreground; dragging the explorer up alongside it would be a second window fighting for it.
 *
 * Act-then-hide, like `navigate`/`reveal`/`open` already do while the palette is `alwaysOnTop`.
 */
export const openUrlFromPalette = async (url: string) => {
  try {
    await openUrl(url);
  } catch (e) {
    await showMain();
    await emitOpenFailed(String(e));
  } finally {
    await hidePalette();
  }
};
