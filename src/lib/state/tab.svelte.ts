// One tab's navigation state: where it is, how it got there, what is listed. Instances live
// in tabs.svelte.ts; consumers read `tabs.active` — see CONTRIBUTING.md § 1.
import { SvelteSet } from 'svelte/reactivity';
import { pathKind, readDir } from '$lib/api/fs';
import { readArchiveDir } from '$lib/api/archive';
import type { FileEntry } from '$lib/types/fs';
import type { Location } from '$lib/types/location';
import type { SortKey } from '$lib/data/file-columns';
import { parentLocation, pathLocation, recentLocations, sameLocation } from '$lib/utils/location';
import { samePath } from '$lib/utils/path';
import { entryComparator, firstDirectionFor } from '$lib/utils/sort';
import {
  effectiveFolderView,
  rememberFolderView,
  type FolderLayout,
  type FolderViewState,
} from '$lib/utils/folder-views';
import { gallery } from '$lib/state/gallery.svelte';
import { applications } from '$lib/state/applications.svelte';
import { uninstall } from '$lib/state/uninstall.svelte';
import { places } from '$lib/state/places.svelte';
import { recycle } from '$lib/state/recycle.svelte';
import { recent } from '$lib/state/recent.svelte';
import { settings, type IconSize, type ViewMode } from '$lib/state/settings.svelte';
import { logError } from '$lib/api/log';

interface HistoryEntry {
  location: Location;
  scroll: number;
}

/**
 * A folder that would not list and is not there any more leaves Recent: Home and the palette
 * stop offering a folder that can only fail again. Asked only after a failed read, so a
 * healthy navigate costs nothing; a path that is there (unreadable, not a folder) stays.
 */
const forgetIfGone = async (path: string) => {
  try {
    if ((await pathKind(path)) === 'missing') recent.forget(path);
  } catch (e) {
    logError('tab.forgetIfGone', e);
  }
};

export class TabState {
  /** A folder, or a place (Home, This PC) with no path. Replaced wholesale, never mutated. */
  location = $state.raw<Location>(pathLocation(''));
  /** The folder's path; '' on a place, so every "current folder" reader keeps working. */
  path = $derived(this.location.kind === 'path' ? this.location.path : '');
  isFolder = $derived(this.location.kind === 'path');
  /**
   * Inside a zip / 7z / tar.* (plan 16, Phase 4). Read-only: `isFolder` stays false and `path`
   * stays '', so every write action, the watcher and `reload` skip it by type; the file list
   * still shows (`showsList`).
   */
  inArchive = $derived(this.location.kind === 'archive');
  /** What the list says while it waits: a tar.* is decompressed once just to list it. */
  loadingText = $derived(this.inArchive ? 'Reading archive…' : 'Loading…');
  /** Replaced wholesale by every listing, never mutated — raw, so 100k entries are not proxied. */
  entries = $state.raw<FileEntry[]>([]);
  loading = $state(false);
  error = $state<string | null>(null);
  /**
   * How this folder is being looked at: its grouping, its sort column and its direction.
   *
   * ⭐ **Per FOLDER, the way Explorer is.** A folder the person has sorted or grouped by hand
   * keeps that, by path, across navigations, tabs and restarts (`settings.folderViews`); a
   * folder with nothing remembered uses the global defaults, exactly as before this existed —
   * except Downloads, which is seeded grouped by date because Explorer's Downloads *folder
   * template* ships that way. `utils/folder-views` holds all of that reasoning.
   *
   * ⚠️ **Derived, deliberately, and there must be no `$effect` here.** Two reasons:
   *  1. Tabs are constructed at module load, before `settings.load()` has read the file and long
   *     before `places.load()` has said where Downloads is (that OS call has been measured in
   *     tens of seconds). Anything copied at construction would freeze the defaults in, and the
   *     very first tab — the one you always look at — would ignore both.
   *  2. An `$effect` that applied a folder's view on navigation is the exact shape of the render
   *     cascade fixed in `71ddc2a`: it would write state that the listing reads, and a write
   *     under a navigation is one IPC call away from re-listing the folder it just listed.
   *     Reading the store instead means a navigation performs no writes at all — the map is
   *     touched only by a deliberate `sortBy` / `groupBy` / `setSortDir`.
   */
  #view = $derived.by(() =>
    effectiveFolderView(this.path, settings.folderViews, places.downloadsPath, {
      groupKey: settings.groupKey,
      sortKey: settings.sortKey,
      sortDir: settings.sortDir,
      view: settings.view,
      iconSize: settings.iconSize,
    }),
  );
  /** Details / List / Icons for this folder — remembered per folder like the sort (plan 15 G.53). */
  view = $derived(this.#view.view);
  iconSize = $derived(this.#view.iconSize);
  sortKey = $derived(this.#view.sortKey);
  sortDir = $derived(this.#view.sortDir);
  /** Explorer's "Group by"; `null` is a real choice here ("(None)": no headers), not an absence. */
  groupKey = $derived(this.#view.groupKey);
  /**
   * A folder looked at in its Gallery view (plan 15 G.52): the photo grid over this folder's own
   * files instead of the file list. Only a real folder — an archive's rows have no file on disk
   * for a thumbnail.
   */
  showsGallery = $derived(this.isFolder && this.view === 'gallery');
  /** The file list is mounted: a real folder (not in Gallery view) or an archive's inside. */
  showsList = $derived((this.isFolder || this.inArchive) && !this.showsGallery);
  /**
   * The group headings folded shut, by label. Per tab and not written to settings: a fold is
   * how you are reading *this* list right now, the way Explorer treats it — and the labels
   * ("Today", "R", "Large") mean the same thing in the next folder this tab opens, so it
   * survives a navigation but not a restart. `groupBy` empties it: a different column is a
   * different ladder of labels and a stale "Today" would fold nothing.
   */
  collapsedGroups = new SvelteSet<string>();
  /** The search box's instant filter: a name substring, case-insensitive; '' shows all. */
  filter = $state('');

  // The selection is per tab (Explorer keeps each tab's); `state/selection.svelte.ts` is the
  // one API over whichever tab is active and stores here.
  selected = new SvelteSet<string>();
  /** where a Shift-range starts */
  anchor = $state<string | null>(null);
  /** the row keyboard navigation moves */
  focused = $state<string | null>(null);
  /** the list's scroll position along its axis, restored when the tab is activated */
  scrollOffset = $state(0);
  /**
   * Where the list should scroll after a move lands: the top for a new folder, the saved
   * offset for Back / Forward. Replaced wholesale on every landing, so the scroll hook can
   * react to "a navigation happened" even when the offset is the same number as before.
   */
  scrollRestore = $state.raw<{ offset: number }>({ offset: 0 });

  /** A history entry remembers where the list was scrolled, so Back puts you where you were. */
  #back = $state.raw<HistoryEntry[]>([]);
  #forward = $state.raw<HistoryEntry[]>([]);
  /**
   * The stacks as they were before the first of a run of unfinished Back / Forward steps, and
   * the entry the latest step is heading to. A step takes its entry off the stack before the
   * read (so a second quick click takes the next one); if the step never lands — the read
   * fails, or a click on a folder supersedes it — the stacks go back to this snapshot.
   */
  #stepBase: { back: HistoryEntry[]; forward: HistoryEntry[] } | null = null;
  #heading: HistoryEntry | null = null;

  canGoBack = $derived(this.#back.length > 0);
  canGoForward = $derived(this.#forward.length > 0);
  canGoUp = $derived(parentLocation(this.location) !== null);
  /** The address bar's ▾ list: where this tab has been, newest first, each once (`recentLocations`). */
  history = $derived(
    recentLocations(
      this.#back.map((e) => e.location),
      this.location,
      this.#forward.map((e) => e.location),
    ),
  );

  /**
   * What the list shows: hidden filtered, the instant filter applied, sorted. Cached until a
   * listing, the filter or the sort changes.
   */
  visible = $derived.by(() => {
    const needle = this.filter.trim().toLowerCase();
    const list = this.entries.filter(
      (e) =>
        (settings.showHidden || !e.isHidden) &&
        (needle === '' || e.name.toLowerCase().includes(needle)),
    );
    return list.sort(
      entryComparator(this.sortKey, this.sortDir, { foldersFirst: settings.foldersFirst }),
    );
  });

  /**
   * Which request owns the screen. Every `navigate` and every `reload` takes a number, and no
   * write after an `await` lands unless its number is still the current one. Reads overlap all
   * the time — a click on a slow folder then a fast one, the watcher, the 5 s WSL poll, F5, the
   * re-list after each action — and nothing makes them resolve in the order they were started.
   * Comparing paths instead cannot do this job: F5 on the folder already open, and A→B→A, both
   * compare equal, so a slow earlier read would pass the test and land on top of a newer one.
   */
  #generation = 0;

  /**
   * True while a `navigate` is reading. A reload refreshes the folder on screen rather than
   * asking for a new one, so it must not take the number away from a move already under way:
   * a watcher tick would otherwise cancel the folder you just clicked and leave `loading` up
   * for ever.
   */
  #navigating = false;

  /**
   * The folder `error` is about — not necessarily the one on screen (a failed archive read or
   * `wsl.open` leaves you where you were with the message). Only a read of that same
   * folder may take the message away: a clean read of the folder you are sitting in does not
   * answer a failed navigate elsewhere, nor a WSL distro that would not start (`wsl.open`
   * writes `error` directly too).
   */
  #errorPath: string | null = null;

  /**
   * Navigate and record history. A string is a path. `replace` re-reads the current folder
   * without a history entry. A place has nothing to read: the tiles come from `places`.
   */
  async navigate(
    to: Location | string,
    { replace = false, step }: { replace?: boolean; step?: 'back' | 'forward' } = {},
  ) {
    const target = typeof to === 'string' ? pathLocation(to) : to;
    const generation = ++this.#generation;
    const current = () => generation === this.#generation;
    // a click on a folder supersedes any unfinished Back / Forward: its entries come back first
    if (!step) this.#undoStep();
    const stepEntry = step ? this.#step(step) : null;
    const moved = stepEntry !== null || !sameLocation(target, this.location);
    this.error = null;
    this.#errorPath = null;
    this.filter = '';
    if (target.kind === 'archive')
      return this.#navigateArchive(target, replace, stepEntry, moved, current, step);
    if (target.kind !== 'path') {
      this.#record(target, replace);
      this.#land(stepEntry, moved);
      this.location = target;
      this.entries = [];
      this.loading = false;
      this.#navigating = false;
      return;
    }
    this.loading = true;
    this.#navigating = true;
    try {
      const listing = await readDir(target.path);
      if (!current()) return;
      this.#record(target, replace);
      this.#land(stepEntry, moved);
      this.location = pathLocation(listing.path);
      this.entries = listing.entries;
      recent.visited(listing.path);
    } catch (e) {
      if (!current()) return;
      // The move happened, the listing did not: show the folder you asked for with no rows and
      // its message, as Explorer does. Leaving the old rows up put the message below them, off
      // screen, so nothing seemed to change. History lands as for a good move, so Back returns
      // to the folder you came from.
      this.#record(target, replace);
      this.#land(stepEntry, moved);
      this.location = target;
      this.entries = [];
      this.error = String(e);
      this.#errorPath = target.path;
      void forgetIfGone(target.path);
    } finally {
      // A superseded navigate lowers nothing: the newer read still owns `loading`, and it is
      // the one that will lower it.
      if (current()) {
        this.loading = false;
        this.#navigating = false;
      }
    }
  }

  /** `navigate`'s archive branch: the same landing rules, `readArchiveDir` for the rows. */
  async #navigateArchive(
    target: Extract<Location, { kind: 'archive' }>,
    replace: boolean,
    stepEntry: HistoryEntry | null,
    moved: boolean,
    current: () => boolean,
    step: 'back' | 'forward' | undefined,
  ) {
    this.loading = true;
    this.#navigating = true;
    try {
      const listing = await readArchiveDir(target.archive, target.inner);
      if (!current()) return;
      this.#record(target, replace);
      this.#land(stepEntry, moved);
      this.location = target;
      this.entries = listing.entries;
    } catch (e) {
      if (!current()) return;
      if (step) this.#undoStep();
      this.error = String(e);
    } finally {
      if (current()) {
        this.loading = false;
        this.#navigating = false;
      }
    }
  }

  /** F5 inside an archive: read the listing again (Rust re-reads it if the file changed). */
  async #reloadArchive() {
    const loc = this.location;
    if (loc.kind !== 'archive' || this.#navigating) return;
    const generation = ++this.#generation;
    try {
      const listing = await readArchiveDir(loc.archive, loc.inner);
      if (generation !== this.#generation) return;
      this.entries = listing.entries;
      this.error = null;
    } catch (e) {
      if (generation !== this.#generation) return;
      this.error = String(e);
    }
  }

  /**
   * Record the move, at the moment it lands rather than when it was asked for. Two clicks in a
   * row would otherwise both record the folder we started on — Back twice, and you do not move
   * — and a navigate that is abandoned half way would leave an entry for a folder never shown.
   * Call before `location` is replaced.
   *
   * ⚠️ The blank tab a `TabState` is built as (`pathLocation('')`) is never recorded: it is not
   * somewhere you went. A Ctrl+N window lands on its start place with a plain `navigate`, and
   * recording the blank put a "New tab" with no folder one Back behind Home (and behind every
   * start place) — Back from the Recycle Bin, then Back again, landed there.
   */
  #record(target: Location, replace: boolean) {
    if (replace || sameLocation(target, this.location)) return;
    if (this.location.kind === 'path' && this.location.path === '') return;
    this.#back = [...this.#back, { location: this.location, scroll: this.scrollOffset }];
    this.#forward = [];
  }

  /**
   * Move one entry across the stacks for Back and Forward and hand back the entry now being
   * visited. Unlike `#record` this happens *before* the read, not at the landing point: a step
   * consumes an entry, so two quick clicks on Back would otherwise both peek the same one and
   * two clicks would move one folder. The folder we are leaving is the one the previous
   * unfinished step was heading to, if there is one — not `this.location`, which has not moved.
   * `#undoStep` puts the stacks back if the run never lands.
   */
  #step(dir: 'back' | 'forward'): HistoryEntry {
    this.#stepBase ??= { back: this.#back, forward: this.#forward };
    const leaving = this.#heading ?? { location: this.location, scroll: this.scrollOffset };
    const from = dir === 'back' ? this.#back : this.#forward;
    const to = from.at(-1) ?? leaving;
    if (dir === 'back') {
      this.#back = this.#back.slice(0, -1);
      this.#forward = [...this.#forward, leaving];
    } else {
      this.#forward = this.#forward.slice(0, -1);
      this.#back = [...this.#back, leaving];
    }
    this.#heading = to;
    return to;
  }

  /** Forget an unfinished run of steps: the stacks return to how they were before it. */
  #undoStep() {
    if (this.#stepBase === null) return;
    this.#back = this.#stepBase.back;
    this.#forward = this.#stepBase.forward;
    this.#stepBase = null;
    this.#heading = null;
  }

  /**
   * The move has landed: the steps are final, and the list scrolls to where this entry was left
   * (Back / Forward) or to the top (a new folder). A move that stays in the same folder — a
   * refresh through `navigate` — keeps its place.
   */
  #land(stepEntry: HistoryEntry | null, moved: boolean) {
    this.#stepBase = null;
    this.#heading = null;
    if (!moved) return;
    const offset = stepEntry?.scroll ?? 0;
    this.scrollOffset = offset;
    this.scrollRestore = { offset };
  }

  /** true while F5 / the Refresh button re-reads; the button spins on it (at least 700 ms). */
  refreshing = $state(false);

  /**
   * How many refreshes are in flight. Two overlapping F5s used to fight over the flag above:
   * the first to finish lowered the spinner while the second read was still out. Only the last
   * one to settle lowers it.
   */
  #refreshes = 0;

  /** Re-read the folder without flicker; on a place, re-ask the OS for folders and drives. */
  refresh = async () => {
    this.#refreshes++;
    this.refreshing = true;
    const started = Date.now();
    try {
      if (this.isFolder) await this.reload();
      else if (this.inArchive) await this.#reloadArchive();
      else if (this.location.kind === 'recycle-bin') await recycle.reload();
      else if (this.location.kind === 'gallery') await gallery.reload();
      else if (this.location.kind === 'applications')
        await Promise.all([applications.reload(), uninstall.reload()]);
      // Home also shows recent files; F5 alone used to reload them, the Refresh button did not
      else if (this.location.kind === 'home')
        await Promise.all([places.reload(), recent.loadFiles()]);
      else await places.reload();
    } catch (e) {
      // There used to be no catch here at all, only `finally`: an F5 on This PC that failed
      // stopped the spinner and said nothing whatsoever.
      logError('tab.refresh', e);
    } finally {
      const left = 700 - (Date.now() - started);
      if (left > 0) await new Promise((r) => setTimeout(r, left));
      if (--this.#refreshes === 0) this.refreshing = false;
    }
  };

  /**
   * Re-read the folder without flicker: the listing is swapped in whole, `loading` is never
   * raised (no "Loading…", no scroll reset) and a failed read keeps the old rows. Used after
   * our own operations and by the watcher; F5 is `refresh`.
   */
  async reload() {
    // a move already under way will list this tab itself; re-reading the folder it is leaving
    // would only race that listing
    if (!this.isFolder || !this.path || this.#navigating) return;
    const path = this.path;
    const generation = ++this.#generation;
    const current = () => generation === this.#generation;
    try {
      const listing = await readDir(path);
      if (!current()) return;
      this.entries = listing.entries;
      if (this.#errorPath !== null && samePath(this.#errorPath, path)) {
        this.error = null;
        this.#errorPath = null;
      }
    } catch (e) {
      // Guarded like the success path: without this, the folder you have just left paints its
      // read error over the folder you moved to.
      if (!current()) return;
      this.error = String(e);
      this.#errorPath = path;
    }
  }

  // Both peek rather than pop: `navigate` owns the stacks from here on, so that a read which
  // fails can put them back (`#step`). `replace` keeps `#record` from adding an entry on top.
  back = () => {
    const to = this.#back.at(-1);
    if (to === undefined) return;
    return this.navigate(to.location, { replace: true, step: 'back' });
  };

  forward = () => {
    const to = this.#forward.at(-1);
    if (to === undefined) return;
    return this.navigate(to.location, { replace: true, step: 'forward' });
  };

  /** A folder goes to its parent; a drive root goes to This PC. */
  up = () => {
    const to = parentLocation(this.location);
    if (to) return this.navigate(to);
  };

  /**
   * A header click. The same column flips; a new one opens the way Explorer opens it —
   * A→Z for Name and Type, newest and largest first for the dates and the size. Opening
   * "Date modified" oldest-first was the reason a Downloads folder looked unsorted.
   */
  sortBy(key: SortKey) {
    const dir =
      this.sortKey === key ? (this.sortDir === 'asc' ? 'desc' : 'asc') : firstDirectionFor(key);
    this.#remember({ groupKey: this.groupKey, sortKey: key, sortDir: dir });
  }

  /**
   * "Sort by name" from the palette or a menu row: SET the order (A→Z for Name, newest first for
   * dates, as `firstDirectionFor` opens them), never flip it. `sortBy` is the header click, which
   * flips the same column, so a palette "Sort by name" on a folder already by name turned it Z→A
   * (Mac, 2026-10-06).
   */
  sortTo(key: SortKey, dir: 'asc' | 'desc' = firstDirectionFor(key)) {
    if (this.sortKey === key && this.sortDir === dir) return;
    this.#remember({ groupKey: this.groupKey, sortKey: key, sortDir: dir });
  }

  /**
   * Switch this folder's layout. `iconSize` is only given for a grid step; leaving it out keeps
   * the folder's own size. A place has no folder, so there it lands on the global default.
   */
  setView(view: ViewMode, iconSize?: IconSize) {
    this.#remember({
      groupKey: this.groupKey,
      sortKey: this.sortKey,
      sortDir: this.sortDir,
      view,
      iconSize,
    });
  }

  /** The Group by rows. `null` is "(None)" — the list goes back to one flat run of rows. */
  groupBy(key: SortKey | null) {
    this.#remember({ groupKey: key, sortKey: this.sortKey, sortDir: this.sortDir });
    this.collapsedGroups.clear();
  }

  /**
   * File the choice under the folder it was made in, so coming back to this folder finds it as
   * it was left — and so grouping ONE folder no longer groups every folder, which is what a
   * single global `groupKey` did.
   *
   * ⚠️ All three fields are written together on purpose: a grouping is meaningless detached
   * from the sort it groups by, so they are one view and are stored as one.
   *
   * A place (Home, This PC) has no folder to file anything under — its only sortable rows are a
   * search's results — so there the choice lands on the global default, which is also what every
   * folder with nothing remembered is shown with.
   */
  #remember(view: FolderViewState & Partial<FolderLayout>) {
    if (this.path === '') {
      settings.groupKey = view.groupKey;
      settings.sortKey = view.sortKey;
      settings.sortDir = view.sortDir;
      // a place has no files for a Gallery view, so it never becomes the global default
      if (view.view !== undefined && view.view !== 'gallery') settings.view = view.view;
      if (view.iconSize !== undefined) settings.iconSize = view.iconSize;
      return;
    }
    settings.folderViews = rememberFolderView(settings.folderViews, this.path, view);
  }

  /** A click on a group heading's chevron: fold it shut, or open it again. */
  toggleGroup(label: string) {
    if (!this.collapsedGroups.delete(label)) this.collapsedGroups.add(label);
  }

  /** The Sort by menu's Ascending / Descending rows, which set rather than flip. */
  setSortDir(dir: 'asc' | 'desc') {
    this.#remember({ groupKey: this.groupKey, sortKey: this.sortKey, sortDir: dir });
  }
}
