// What the Applications place shows: every app the machine can start, the same list the
// palette's APPS group reads (`spotlight_apps`, plan 17.1), in the order Rust sends it.
// Loaded when the place shows; F5 asks the OS again. Read-only: nothing here writes a file.
// While the place shows, the folders the apps live in are watched the way the Gallery watches
// Pictures, so an app put back from the Trash (or installed, or removed) shows without F5.
import { spotlightApps } from '$lib/api/palette';
import { unwatchPath, watchPath } from '$lib/api/watch';
import type { AppEntry } from '$lib/types/palette';
import { parentOf, samePath } from '$lib/utils/path';

/** How long a burst of changes in an app folder settles before the list is asked for again. */
export const APPS_REFRESH_MS = 800;

/**
 * At most this many folders are watched. A Mac or Linux box has a handful (`/Applications`,
 * `~/Applications`, the `.desktop` dirs); a Windows Start Menu has one per program group, and a
 * watcher each is fine for dozens, not for an unbounded list.
 */
export const APPS_WATCH_MAX = 64;

/**
 * The folders the apps live in: the Start Menu shortcut's folder on Windows, the `.app` bundle's
 * or `.desktop` file's folder elsewhere. Store apps have neither and add none. Once each.
 */
export const appFolders = (items: AppEntry[]): string[] => {
  const out: string[] = [];
  for (const a of items) {
    const parent = parentOf(a.lnkPath || a.path);
    if (parent && !out.some((p) => samePath(p, parent))) out.push(parent);
    if (out.length >= APPS_WATCH_MAX) break;
  }
  return out;
};

/** The apps whose name holds `text`, case-insensitively; blank text keeps them all. */
export const filterApps = (items: AppEntry[], text: string): AppEntry[] => {
  const needle = text.trim().toLowerCase();
  if (!needle) return items;
  return items.filter((a) => a.name.toLowerCase().includes(needle));
};

class ApplicationsState {
  /** Replaced wholesale per load — raw, a few hundred rows are not proxied. */
  items = $state.raw<AppEntry[]>([]);
  loading = $state(false);
  loaded = $state(false);
  error = $state<string | null>(null);
  /** type-to-filter text, kept across visits like a search box */
  filter = $state('');

  shown = $derived(filterApps(this.items, this.filter));

  /** First show: Rust's cached list is fine. */
  load() {
    return this.loaded ? Promise.resolve() : this.#read(false);
  }

  /**
   * Called after each fresh read (F5, a watched folder changed): the uninstall rows are a second
   * list of the same bundles, and a tile they do not know greys "Move to Trash" as not found.
   * Set by `uninstall.svelte.ts` (it imports this file, so this one cannot import it back).
   */
  onRefresh: (() => void) | null = null;

  /** F5 and "Try again": make Rust walk the OS again. */
  reload() {
    return this.#read(true);
  }

  /**
   * Which read is the current one: the mount effect and an F5 can overlap, and an older read that
   * lands last must not put back its rows or clear a newer failure (same rule as the Gallery).
   */
  #generation = 0;

  async #read(refresh: boolean) {
    const generation = ++this.#generation;
    const current = () => generation === this.#generation;
    this.loading = true;
    this.error = null;
    try {
      const items = await spotlightApps(refresh);
      if (!current()) return;
      this.items = items;
      this.loaded = true;
      if (this.#watching) this.#sync();
      if (refresh) this.onRefresh?.();
    } catch (e) {
      if (!current()) return;
      this.error = String(e);
    } finally {
      if (current()) this.loading = false;
    }
  }

  /** Folders being watched while the place shows. */
  #roots: string[] = [];
  #watching = false;
  #timer: ReturnType<typeof setTimeout> | undefined;

  /** Watch the app folders while the place shows; safe to call twice; `unwatch` ends it. */
  watch() {
    this.#watching = true;
    this.#sync();
  }

  unwatch() {
    this.#watching = false;
    clearTimeout(this.#timer);
    this.#timer = undefined;
    for (const p of this.#roots) void unwatchPath(p).catch(() => {});
    this.#roots = [];
  }

  /** Watch what the current list names, and stop watching what it no longer does. */
  #sync() {
    const wanted = appFolders(this.items);
    for (const p of wanted)
      if (!this.#roots.some((r) => samePath(r, p))) void watchPath(p).catch(() => {});
    for (const r of this.#roots)
      if (!wanted.some((p) => samePath(p, r))) void unwatchPath(r).catch(() => {});
    this.#roots = wanted;
  }

  /** A watched folder changed: if it is one of ours, ask the OS again once the burst settles. */
  changed(path: string) {
    if (!this.#watching || !this.#roots.some((r) => samePath(r, path))) return;
    clearTimeout(this.#timer);
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      void this.reload();
    }, APPS_REFRESH_MS);
  }
}

export const applications = new ApplicationsState();
