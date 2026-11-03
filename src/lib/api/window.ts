// The only place the Tauri window and webview APIs appear. The custom title bar and the drop
// handling call these through hooks / state.
import { invoke } from '@tauri-apps/api/core';
import type { UnlistenFn } from '@tauri-apps/api/event';
import { getCurrentWebview, type DragDropEvent } from '@tauri-apps/api/webview';
import { getCurrentWindow } from '@tauri-apps/api/window';
import type { SnapKey } from '$lib/utils/key-label';

const win = () => getCurrentWindow();

/** A drag from another app over the window, or its drop. Positions are physical pixels. */
export type ExternalDragEvent =
  | { type: 'enter' | 'over'; x: number; y: number }
  | { type: 'drop'; paths: string[]; x: number; y: number }
  | { type: 'leave' };

const toExternal = (e: DragDropEvent): ExternalDragEvent => {
  if (e.type === 'leave') return { type: 'leave' };
  if (e.type === 'drop') return { type: 'drop', paths: e.paths, x: e.position.x, y: e.position.y };
  return { type: e.type, x: e.position.x, y: e.position.y };
};

/** Subscribe to drags from other apps (Tauri's `dragDropEnabled`); returns the unlisten fn. */
export const onExternalDrag = (cb: (e: ExternalDragEvent) => void) =>
  getCurrentWebview().onDragDropEvent((e) => cb(toExternal(e.payload)));

/**
 * Put this window on screen — the first reveal, or a window started `--hidden` when the app
 * turns out not to be resident. Rust shows it and then lands the maximize the last run left it
 * (`commands::windows::show_window`), so that does not wait for a focus the show may not bring.
 */
export const showWindow = () => invoke<void>('show_window');
/** Whether the window is on screen (not hidden in the tray). */
export const isWindowVisible = () => win().isVisible();
/** The whole UI at a factor, like a browser's Ctrl+Plus — the "text size" control. */
export const setZoom = (factor: number) => getCurrentWebview().setZoom(factor);
export const minimize = () => win().minimize();
export const toggleMaximize = () => win().toggleMaximize();
export const close = () => win().close();
export const isMaximized = () => win().isMaximized();
/** Full screen (a Mac's green button): the traffic lights hide, so the strip drops its inset. */
export const isFullscreen = () => win().isFullscreen();
/** The OS title (taskbar, Alt+Tab): the folder, as Explorer's is. */
export const setTitle = (title: string) => win().setTitle(title);
export const startDragging = () => win().startDragging();
/**
 * One Snap key in this window (plan 20): Windows 11's rules for Win+arrows, worked in Rust
 * (`commands::window_layout::snap_window`). Rejects on Wayland, where nothing can move.
 */
export const snapWindow = (key: SnapKey) => invoke<void>('snap_window', { key });
/** Windows' taskbar commands, for every Trove window at once. */
export type WindowLayout = 'cascade' | 'stacked' | 'side-by-side';
/**
 * Cascade / stack / tile every shown Trove window on this window's monitor (Spotlight: on the
 * main window's). Resolves to how many moved; rejects on Wayland, where nothing can move.
 */
export const arrangeWindows = (layout: WindowLayout) =>
  invoke<number>('arrange_windows', { layout });
/** This window's label: `main`, `main-<n>` (explorer windows) or `palette` (Spotlight). */
export const windowLabel = () => win().label;
/** macOS: force the window's appearance (and so its glass material) light or dark; `null`
 * hands it back to the system appearance. Explorer windows only (capability `default`). */
export const setNativeTheme = (t: 'light' | 'dark' | null) => win().setTheme(t);

/**
 * Run `cb` when the window gains focus — what every way of showing a hidden window ends in
 * (the tray, a second launch, the Dock, usually `showWindow`). Returns the unlisten function.
 */
export const onFocused = (cb: () => void) =>
  win().onFocusChanged(({ payload }) => {
    if (payload) cb();
  });

/** Subscribe to resize; returns the unlisten function. */
export const onResized = (cb: () => void) => win().onResized(cb);

/**
 * Subscribe to the window's close request — the ONE hook that covers every close path: our
 * caption button and the last-tab close (which call `close()` above), and Alt+F4, the taskbar's
 * Close and an OS shutdown, which run no frontend code of their own at all. An async `cb` holds
 * the close open for exactly as long as its promise takes, so an `invoke` round trip can still
 * land. Returns the unlisten function.
 *
 * ⛔ WHY THIS DOES NOT USE TAURI'S OWN AUTO-CLOSE. `c014476` did, and the window became
 * impossible to close — measured on the machine, not reasoned about.
 *
 * Subscribing changes how closing works in Rust: `tauri-2.11.6/src/manager/window.rs:170` calls
 * `api.prevent_close()` the moment the window HAS a JS listener, and hands the decision to the
 * webview. `@tauri-apps/api/window.js:1632-1641` is meant to hand it straight back —
 * `await handler(evt); if (!evt.isPreventDefault()) await this.destroy();` — but
 * `plugin:window|destroy` is ACL-gated behind `core:window:allow-destroy`, which is NOT in the
 * `core:window` default set (`gen/schemas/acl-manifests.json`; `allow-is-visible` is, `allow-
 * destroy` is not) and is NOT granted by `capabilities/default.json`. So that `destroy()`
 * rejects with "window.destroy not allowed…", the rejection dies unhandled inside Tauri's own
 * async listener, Rust has already prevented the close — and nothing is left anywhere that can
 * close the window. `WM_CLOSE` posted straight at the hwnd did nothing for 12 s; `Stop-Process`
 * was the only way out.
 *
 * So the decision goes back to Rust the one way this app is permitted to take: DETACH the
 * listener, then ask again with `close()` (`core:window:allow-close`, which we do have). With
 * no JS listener the manager does not prevent, and `lib.rs`'s own `CloseRequested` arm gets the
 * decision it was written for — resident → `prevent_close()` + `hide()`, otherwise the native
 * close, `Destroyed`, and `exit_if_last_explorer_window`. Residency needs no guess here at all:
 * the frontend never destroys anything, so there is nothing for it to get wrong, and
 * `c014476`'s `isVisible()` guard goes with the destroy it was guarding.
 *
 * ⚠️ Two details are load-bearing. `preventDefault()` is called FIRST and unconditionally, so
 * the wrapper can never reach the `destroy()` that cannot work. And the detach is AWAITED
 * before `close()`: `_unlisten` (`@tauri-apps/api/event.js:42-48`) drops the JS callback
 * synchronously but removes the RUST listener only when `plugin:event|unlisten` returns, and it
 * is the Rust side that `has_js_listener` reads. That synchronous drop is also why the re-close
 * cannot loop: even if Rust somehow prevented again, no callback is left to hear it.
 *
 * ⛔ AND IT IS ONE-SHOT, DELIBERATELY. The obvious next move — re-arm afterwards, since a
 * resident close leaves the webview alive — is the same bug again.
 * `tauri-runtime-wry-2.11.x/src/lib.rs:2270` shows `close()` only SENDING
 * `WindowMessage::Close` to the event loop and returning; the JS promise therefore resolves
 * BEFORE Rust reads `has_js_listener`. A listener re-attached in that gap makes the manager
 * prevent the close we just asked for, and the window is unclosable again — intermittently,
 * which is worse than always. With no re-arm, a listener can never exist while a close is in
 * flight, and that failure mode is structurally impossible rather than merely unlikely.
 *
 * What that costs is nothing on the path this exists for. The default (`keepRunning: false`) is
 * the destroying path, and it is covered. Resident closes do not need covering: Rust hides the
 * window, the webview and its `SAVE_DELAY_MS` timer live on, and the write lands by itself — see
 * `settings.flush()`'s own note, "Residency masks it". The first close of a session still
 * flushes here as belt; later resident closes ride the timer that already works. The one gap
 * left is a change made in the last 400 ms before the first close of a session that turned
 * `keepRunning` OFF mid-session, and a lost setting there is the right thing to trade for a
 * window that is always closable.
 */
export const onCloseRequested = async (cb: () => void | Promise<void>): Promise<UnlistenFn> => {
  // `sub` is captured by its own handler, so the handler can detach itself even in the sliver
  // where a close arrives before this registration's promise has resolved.
  const sub: Promise<UnlistenFn> = win().onCloseRequested(async (event) => {
    event.preventDefault();
    // Losing one settings write is bad; a window nobody can close is worse. Every step below
    // survives its own failure, and the close goes through regardless.
    try {
      await cb();
    } catch {
      /* the write failed — close anyway */
    }
    await detachSub(sub);
    try {
      await close();
    } catch {
      /* the window may already be on its way out */
    }
  });
  await sub;
  return () => detachSub(sub);
};

/**
 * Detach a Tauri subscription, whatever state it is in. Tauri types the unlisten function as
 * returning `void`, but it really returns the `plugin:event|unlisten` round trip
 * (`@tauri-apps/api/event.js:42-48`), and awaiting that is what removes the listener on the RUST
 * side — the side `has_js_listener` reads. Idempotent, so the handler's own detach and a later
 * teardown can both call it.
 */
const detachSub = async (sub: Promise<UnlistenFn>) => {
  try {
    const unlisten = await sub;
    await unlisten();
  } catch {
    /* already detached, or the window is gone */
  }
};

/** `main` for the first window; `main-2`, `main-3`… for the ones a detach or Ctrl+N opened. */
export const currentWindowLabel = () => win().label;
/** Only the first window owns argv, the tray, the hotkey and the restored tabs. */
export const isMainWindow = () => currentWindowLabel() === 'main';

/**
 * A new explorer window, cascaded from this one, on `target` — a folder path or a place's
 * name ("This PC"), read by the new window's shell from its URL. Resolves to its label.
 */
export const openWindow = (target?: string) =>
  invoke<string>('open_window', { path: target ?? null, from: currentWindowLabel() });

/**
 * A new explorer window with several tabs — a window the last run had open (Restore tabs). The
 * same command as `openWindow`; its URL carries one `open=` per tab and the active one.
 * Cascaded from `from` (the window opened just before, so restored windows do not stack).
 */
export const openWindowWithTabs = (tabs: string[], active: number, from = currentWindowLabel()) =>
  invoke<string>('open_window', { path: tabs[0] ?? null, from, tabs, active });

/** The `?open=` target a secondary window was created with, if any. */
export const windowOpenTarget = (): string | null =>
  new URLSearchParams(window.location.search).get('open');

/** Every `?open=` tab a secondary window was created with, and the `?active=` one. */
export const windowOpenTabs = (search = window.location.search) => {
  const q = new URLSearchParams(search);
  return { tabs: q.getAll('open'), active: Number(q.get('active') ?? 0) || 0 };
};
