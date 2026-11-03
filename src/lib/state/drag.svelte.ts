// An in-app drag: what is being dragged, where the pointer is, which drop target is under it,
// and what a drop would do. Pointer-based, not HTML5 — with the window's `dragDropEnabled` on
// (needed for drops from Explorer) WebView2 never delivers `dragstart` / `drop` to the page.
// The hook (`use-drag`) does the DOM lookup and hands it in as `resolveTarget`; drops from
// other apps arrive through Tauri and land on the same targets.
import { SvelteMap } from 'svelte/reactivity';
import { actions } from '$lib/state/actions.svelte';
import { selection } from '$lib/state/selection.svelte';
import { tabs } from '$lib/state/tabs.svelte';
import { transfers } from '$lib/state/transfers.svelte';
import { dragOut, dropModifiers, sameVolume } from '$lib/api/transfer';
import type { FileEntry } from '$lib/types/fs';
import type { TransferMode } from '$lib/types/transfer';
import { places } from '$lib/state/places.svelte';
import { isWslPath, parentOf, pathKey, pathSep, wslDistroOf } from '$lib/utils/path';
import { onWindows } from '$lib/utils/platform';
import { logError } from '$lib/api/log';
import { pinDropped } from '$lib/data/pin-drop';

/** Hover a folder row or a tab this long while dragging and it opens (Explorer's spring-load). */
export const AUTO_OPEN_MS = 1000;

export type DropKind = 'row' | 'background' | 'sidebar' | 'crumb' | 'tab' | 'pin';

export interface DropTarget {
  /** the folder a drop lands in */
  path: string;
  kind: DropKind;
  /** for `kind: 'tab'`, the tab's index in `tabs.list` */
  tab: number | null;
}

export interface DragModifiers {
  /** the copy key: Option on a Mac, Ctrl elsewhere (the hook maps it) */
  ctrl: boolean;
  shift: boolean;
}

const NO_MODS: DragModifiers = { ctrl: false, shift: false };

/** A path with its trailing separator dropped, keyed by `pathKey` (case folded on Windows only). */
const fold = (p: string) => pathKey(p.replace(onWindows() ? /[\\/]+$/ : /\/+$/, ''));

/** The pointer is outside the window's client area (`size` is the viewport). */
const leftWindow = (x: number, y: number, size: { width: number; height: number }) =>
  x < 0 || y < 0 || x > size.width || y > size.height;

/**
 * A GUESS at the volume a path lives on, for the ghost's label until the backend answers: its
 * drive letter, or its WSL distro; off Windows the deepest listed drive (`/`, `/media/…`,
 * `/Volumes/…`) the path sits under, else the root. ⛔ Never what a drop does: the drive list
 * leaves out a Mac disk image and Linux mounts, so `/Volumes/TroveTest` guessed "the root" and
 * a drop onto it moved the file. The drop asks `sameVolume` (the device id) instead.
 */
export const volumeOf = (
  path: string,
  drives: readonly string[] = places.drives.map((d) => d.path),
) => {
  if (isWslPath(path)) return `wsl:${wslDistroOf(path)?.toLowerCase()}`;
  if (onWindows()) return path.slice(0, 2).toLowerCase();
  const p = fold(path);
  const under = drives.map(fold).filter((d) => p === d || p.startsWith(d + '/'));
  return under.reduce((deepest, d) => (d.length > deepest.length ? d : deepest), '');
};

/** The mode the modifiers force, if any: Ctrl (Option on a Mac) copies, Shift moves. */
const forcedBy = (mods: DragModifiers): TransferMode | null =>
  mods.ctrl ? 'copy' : mods.shift ? 'move' : null;

/**
 * What a drop does: Ctrl forces copy, Shift forces move, else move on the same volume.
 * `same` is the backend's device-id answer (`sameVolume`); without one the `volumeOf` guess
 * stands in — fit for a label, never for the drop itself.
 */
export const effectFor = (
  paths: string[],
  target: string | null,
  mods: DragModifiers,
  same?: boolean,
): TransferMode => {
  const forced = forcedBy(mods);
  if (forced !== null) return forced;
  const [first] = paths;
  if (first === undefined || target === null) return 'move';
  if (same !== undefined) return same ? 'move' : 'copy';
  return volumeOf(first) === volumeOf(target) ? 'move' : 'copy';
};

/** The backend's same-volume answer; a failed ask is "not the same", so the drop copies. */
const askSameVolume = (paths: string[], target: string) =>
  sameVolume(paths, target).catch((e: unknown) => {
    logError('drag.sameVolume', e);
    return false;
  });

/** What a drop does, for real: a modifier decides without asking, else the device id does. */
const dropEffect = async (
  mods: DragModifiers,
  ask: () => Promise<boolean>,
): Promise<TransferMode> => forcedBy(mods) ?? ((await ask()) ? 'move' : 'copy');

/** A drop is a no-op onto the folder the items are in, onto one of them, or into one of them. */
export const isNoOp = (paths: string[], target: string) => {
  const t = fold(target);
  return paths.some((p) => {
    const f = fold(p);
    return fold(parentOf(p) ?? '') === t || f === t || t.startsWith(f + pathSep());
  });
};

class DragState {
  dragging = $state(false);
  /** a drag from another app is over the window: targets highlight, no ghost */
  external = $state(false);
  paths = $state.raw<string[]>([]);
  /** the first dragged entry, for the ghost's icon */
  first = $state.raw<FileEntry | null>(null);
  x = $state(0);
  y = $state(0);
  target = $state.raw<DropTarget | null>(null);
  modifiers = $state<DragModifiers>({ ...NO_MODS });

  /** Injected by the hook: the `[data-drop]` element under a point, if any. */
  resolveTarget: (x: number, y: number) => DropTarget | null = () => null;
  /** Injected by the hook: let go of the pointer capture before the OS takes the drag. */
  releasePointer: () => void = () => {};
  /** Injected by the hook: the viewport size (tests pass numbers; there is no `window` there). */
  viewport: () => { width: number; height: number } = () => ({ width: Infinity, height: Infinity });
  /** an OLE drag handed to the OS is in flight; one at a time */
  handingOff = $state(false);

  #hoverTimer: ReturnType<typeof setTimeout> | undefined;
  #swallowClick = false;
  /**
   * This drag's `sameVolume` asks, one per target folder (asked when the target changes, never
   * per pointer move), and the answers that came back, which the ghost's label reads. A drop
   * awaits the same ask. Both are emptied with the drag.
   */
  #asks = new Map<string, Promise<boolean>>();
  #answers = new SvelteMap<string, boolean>();

  effect = $derived(
    effectFor(
      this.paths,
      this.target?.path ?? null,
      this.modifiers,
      this.target === null ? undefined : this.#answers.get(fold(this.target.path)),
    ),
  );
  count = $derived(this.paths.length);

  /** Begin dragging `paths`; a drag that starts on an unselected row selects it first. */
  start(paths: string[], x: number, y: number, first: FileEntry | null = null) {
    // rows inside an archive have no real path (`archive` + NUL + `inner`): nothing to drag out yet
    if (paths.length === 0 || paths.some((p) => p.includes('\u0000'))) return;
    const [lead] = paths;
    if (!selection.has(lead)) {
      selection.clear();
      selection.selectAll([lead]);
      selection.focused = lead;
    }
    this.#asks = new Map();
    this.#answers.clear();
    this.paths = paths;
    this.first = first;
    this.dragging = true;
    this.external = false;
    this.modifiers = { ...NO_MODS };
    this.move(x, y, NO_MODS);
  }

  move(x: number, y: number, mods: DragModifiers) {
    this.x = x;
    this.y = y;
    this.modifiers = { ...mods };
    if (this.dragging && !this.handingOff && leftWindow(x, y, this.viewport())) {
      void this.handOff();
      return;
    }
    this.#setTarget(this.resolveTarget(x, y));
  }

  /**
   * The pointer left the window with the button down: the OS takes over (OLE on Windows, an
   * AppKit session on a Mac, a GTK drag on Linux). The native drag reads the mouse from here
   * on, so this must happen on the first move outside, at once. A `move` outcome means the
   * target took the files away; the list re-reads.
   *
   * Only reached from a pointer move whose `buttons` says the left button is down (the hook
   * checks): that is the page vouching for the press, which the Mac side trusts over its own
   * HID button state. The drag state is reset BEFORE the capture is let go, so a
   * `lostpointercapture` or `pointercancel` the release triggers finds nothing to cancel.
   */
  async handOff() {
    const paths = this.paths;
    if (paths.length === 0 || this.handingOff) return;
    // the copy key held (Ctrl, Option on a Mac) = copy only, read before the reset clears it
    const allowMove = !this.modifiers.ctrl;
    this.handingOff = true;
    this.#reset(true);
    this.releasePointer();
    try {
      const outcome = await dragOut(paths, allowMove);
      if (outcome.effect === 'move') await tabs.active.reload();
    } catch (e) {
      logError('drag.handoffToOs', e);
      // the OS refused the drag (nothing to do; the rows are where they were)
    } finally {
      this.handingOff = false;
      // The OS ran the drag's own loop and took the pointer-up (a Mac sends a synthetic one,
      // and its `click`, before this): a flag left up would eat the next real row click.
      this.#swallowClick = false;
    }
  }

  /** Drop what is dragged onto the current target; nothing happens without one or onto itself. */
  async drop() {
    const { paths, target } = this;
    const mods = { ...this.modifiers };
    // the ask is taken before the reset empties the cache; the reset (and its click swallow)
    // still happens at once, before anything is awaited
    const asks = this.#asks;
    this.#reset(true);
    if (target === null) return;
    if (target.kind === 'pin') return pinDropped(paths);
    if (isNoOp(paths, target.path)) return;
    const mode = await dropEffect(
      mods,
      () => asks.get(fold(target.path)) ?? askSameVolume(paths, target.path),
    );
    await this.#transfer(paths, target.path, mode);
  }

  /** The caller is a pointer handler that cannot await, so a failure is reported here. */
  async #transfer(paths: string[], destination: string, mode: TransferMode) {
    try {
      await transfers.request(paths, destination, mode);
    } catch (e) {
      logError('drag.transfer', e);
      actions.notify(String(e), 'error');
    }
  }

  /** A new press starts a new gesture: a stale "swallow the next click" must not outlive it. */
  pressed() {
    this.#swallowClick = false;
  }

  /**
   * Mid-handoff the armed swallow survives: our own drag leaving the window reaches here as the
   * OS drag's `leave`, and on a Mac the click that ends the press is still on its way to the row.
   */
  cancel() {
    this.#reset(this.dragging || this.handingOff);
  }

  /** A drag from another app is over (x, y): light the target the same way. */
  externalOver(x: number, y: number) {
    this.external = true;
    this.x = x;
    this.y = y;
    this.#setTarget(this.resolveTarget(x, y));
  }

  /**
   * Files dropped at (x, y) from outside this webview: into the target, else the current
   * folder. Explorer's rule, as an in-app drop: Ctrl copies, Shift moves, else move on the
   * same volume (the device id the backend reads) and copy across. Tauri's payload carries
   * no modifiers, so the keys are read from the OS the moment the drop arrives.
   */
  async externalDrop(paths: string[], x: number, y: number) {
    // first, before any other await: the person may let go of the key right after the button
    const held = dropModifiers().catch((e: unknown) => {
      logError('drag.dropModifiers', e);
      return NO_MODS;
    });
    const target = this.resolveTarget(x, y);
    this.#reset(this.handingOff);
    // the pin tail has no folder (`data-drop=""`): it must never reach a transfer
    if (target?.kind === 'pin') return paths.length === 0 ? undefined : pinDropped(paths);
    const destination = target?.path ?? (tabs.active.isFolder ? tabs.active.path : null);
    if (destination === null || paths.length === 0) return;
    if (isNoOp(paths, destination)) return;
    const mode = await dropEffect(await held, () => askSameVolume(paths, destination));
    await this.#transfer(paths, destination, mode);
  }

  /** The click that follows a pointer-up which ended a drag must not change the selection. */
  swallowClick() {
    const s = this.#swallowClick;
    this.#swallowClick = false;
    return s;
  }

  /**
   * Only folders pin (Explorer's Quick access too). A drag from another app carries no entries
   * until the drop, so it is allowed; an in-app drag is judged by its first item.
   */
  get canPin() {
    return this.external || this.first?.isDir === true;
  }

  /**
   * A drop here would do nothing (the folder the items are in, or one of them): the target stays
   * for the hover timers, but it does not light and the ghost names no action (Explorer's no-drop).
   */
  get noOp() {
    return (
      this.target !== null &&
      this.target.kind !== 'pin' &&
      this.paths.length > 0 &&
      isNoOp(this.paths, this.target.path)
    );
  }

  /**
   * Is `path` on `surface` the drag's target? The same folder shows in the sidebar, a tab, the
   * crumbs and the list: only the surface the pointer is over may light, not all of them.
   */
  isTarget(path: string, surface: DropKind) {
    // ⛔ the pin tail has no folder (`path` ''): it must never light the row whose path folds
    // to '' too (`/`, the File System row)
    return (
      !this.noOp &&
      this.target !== null &&
      this.target.kind !== 'pin' &&
      this.target.kind === surface &&
      fold(this.target.path) === fold(path)
    );
  }

  isTargetTab(index: number) {
    return (
      !this.noOp && this.target !== null && this.target.kind === 'tab' && this.target.tab === index
    );
  }

  #setTarget(found: DropTarget | null) {
    // a file over the pin tail is over nothing: no Pin badge, no outline, and a drop does nothing
    const next = found?.kind === 'pin' && !this.canPin ? null : found;
    const same =
      next !== null &&
      this.target !== null &&
      next.kind === this.target.kind &&
      next.tab === this.target.tab &&
      fold(next.path) === fold(this.target.path);
    if (same) return;
    this.target = next;
    if (this.dragging && next !== null && next.kind !== 'pin') this.#ask(next.path);
    clearTimeout(this.#hoverTimer);
    if (next !== null && (next.kind === 'row' || next.kind === 'tab')) {
      this.#hoverTimer = setTimeout(() => this.#autoOpen(next), AUTO_OPEN_MS);
    }
  }

  /** Spring-load: a folder row opens in the tab, a tab becomes active. The drag continues. */
  #autoOpen(target: DropTarget) {
    if (!this.dragging && !this.external) return;
    if (target.kind === 'tab' && target.tab !== null) tabs.activate(target.tab);
    else if (target.kind === 'row' && !isNoOp(this.paths, target.path)) {
      void tabs.active.navigate(target.path);
    }
  }

  /** Ask once per target folder for this drag; the answer lands in `#answers` for the label. */
  #ask(target: string) {
    const key = fold(target);
    if (this.paths.length === 0 || this.#asks.has(key)) return;
    const asks = this.#asks;
    const ask = askSameVolume(this.paths, target);
    asks.set(key, ask);
    void ask.then((same) => {
      // a drag that ended meanwhile has a new cache: its answer is not for this one
      if (this.#asks === asks) this.#answers.set(key, same);
    });
  }

  #reset(swallow: boolean) {
    clearTimeout(this.#hoverTimer);
    this.#asks = new Map();
    this.#answers.clear();
    this.#swallowClick = swallow;
    this.dragging = false;
    this.external = false;
    this.paths = [];
    this.first = null;
    this.target = null;
    this.modifiers = { ...NO_MODS };
  }
}

export const drag = new DragState();
