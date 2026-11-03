// The one recursive search, on the active tab, as Explorer does it: Enter in the box starts
// it under the tab's folder — or, from Home / This PC / Gallery, across every drive — batches
// of hits stream in over an event, the chips restart it, Escape or a navigation clears it. Results are a plain array
// appended to in place (copying 200k hits per batch is O(n²)) and announced through a version
// counter that is bumped at most every RESULTS_FLUSH_MS while a search runs, so the list and
// the sort under it wake up a few times a second instead of once per batch.
import { cancelSearch, onSearchResults, startSearch } from '$lib/api/search';
import { indexSearch } from '$lib/api/palette';
import { wslRunningDistros } from '$lib/api/wsl';
import { emptyChips, type SearchChips } from '$lib/data/search-filters';
import { places } from '$lib/state/places.svelte';
import { settings } from '$lib/state/settings.svelte';
import { tabs } from '$lib/state/tabs.svelte';
import type { FileEntry } from '$lib/types/fs';
import type { Location } from '$lib/types/location';
import type { SearchBatch, SearchQuery } from '$lib/types/search';
import { sameLocation } from '$lib/utils/location';
import { wslRootFor } from '$lib/utils/path';
import { parseQuery } from '$lib/utils/search-query';

/**
 * From a place: every drive, plus the root of every WSL distro that is RUNNING — `find` inside
 * the distro answers fast, and a stopped one is never started as a side effect of a This PC
 * search. A distro's own folder tab searches itself without this.
 * ⛔ Not a network share: walking one the person did not open raises macOS's network-volume
 * prompt (and hangs on a dead NFS server). Opening the share and searching there still works.
 */
const placeRoots = async (): Promise<string[]> => {
  const drives = places.drives.filter((d) => !d.network).map((d) => d.path);
  const running = await wslRunningDistros().catch(() => [] as string[]);
  return [...drives, ...running.map(wslRootFor)];
};

/** While a search runs, readers of `results` are told about new hits this often at most. */
export const RESULTS_FLUSH_MS = 100;

/** The most names asked of the index; the Rust command clamps to 500 too. */
const INDEX_MAX = 500;

/** Only a name: no type, extension, date or size filter, and something to match. */
export const isNameOnly = (q: SearchQuery) =>
  q.text !== '' &&
  q.ext === null &&
  q.kind === 'any' &&
  q.modifiedAfterMs === null &&
  q.minBytes === null &&
  q.maxBytes === null;

const norm = (p: string) => p.replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase();
const under = (path: string, root: string) => {
  const p = norm(path);
  const r = norm(root);
  return p === r || p.startsWith(r + '/');
};

const NO_QUERY: SearchQuery = {
  text: '',
  ext: null,
  kind: 'any',
  modifiedAfterMs: null,
  minBytes: null,
  maxBytes: null,
};

class SearchState {
  /** the list shows results instead of the folder */
  active = $state(false);
  running = $state(false);
  /** what was typed; the chips live beside it */
  text = $state('');
  chips = $state<SearchChips>(emptyChips());
  /** where the search started: a folder, or the place whose drives it covers */
  location = $state.raw<Location>({ kind: 'path', path: '' });
  /** the folders walked: `[folder]`, or every drive root from a place */
  roots = $state.raw<string[]>([]);
  query = $state.raw<SearchQuery>(NO_QUERY);
  /** bumped when `#results` has grown; what makes the getter below reactive */
  #version = $state(0);
  #results: FileEntry[] = [];
  #flushTimer: ReturnType<typeof setTimeout> | undefined;
  /** The hits so far. The array is mutated in place, so hold on to it only within a read. */
  get results(): FileEntry[] {
    void this.#version;
    return this.#results;
  }
  scanned = $state(0);
  error = $state<string | null>(null);
  searchId = $state(0);
  /** batches that arrive before `start_search` has handed back the id */
  #early: SearchBatch[] = [];
  #starting = false;

  /**
   * Which start is the current one. `searchId` cannot do this job: it is Rust's id, handed back
   * only once `start_search` has answered, and the window where two starts overlap — a chip
   * toggled, or Enter pressed again, while the drive roots or the id are still in flight — is
   * exactly the window in which there is no id yet. Starts do not resolve in the order they were
   * made (`placeRoots` waits on WSL, `start_search` on Rust), so without this an older start
   * lands last and clears the results of the search that is actually live, then takes `searchId`
   * for itself — after which every batch of the live search is rejected as stale.
   *
   * A start that has been superseded writes nothing at all: not the text, not the results, not
   * the id, not the error, not `running`. The newest start owns all of it.
   */
  #generation = 0;

  /**
   * Ids at or below this belong to a search that has been replaced or cleared. `searchId` is
   * reset to 0 the moment a new start begins (its id is not known yet), so without a floor a
   * late batch or `done` of the old search would match nothing — or, before this, match the old
   * id still held in `searchId` and flip `running` off under the new search.
   */
  #staleUpTo = 0;

  /** Wake readers of `results` now, or within RESULTS_FLUSH_MS if the search is still running. */
  #announce(now: boolean) {
    if (now) {
      clearTimeout(this.#flushTimer);
      this.#flushTimer = undefined;
      this.#version++;
    } else if (this.#flushTimer === undefined) {
      this.#flushTimer = setTimeout(() => this.#announce(true), RESULTS_FLUSH_MS);
    }
  }

  /** Forget the old search's hits and id; its late batches are refused from here on. */
  #retire() {
    // two starts in a row: the second sees no id (0), and the first one's floor must stand
    if (this.searchId > 0) this.#staleUpTo = this.searchId;
    this.searchId = 0;
    this.#results = [];
    this.#announce(true);
  }

  /** A batch from Rust: only the current search's count; the rest are stale. */
  apply(batch: SearchBatch) {
    if (batch.searchId <= this.#staleUpTo) return;
    if (this.#starting && batch.searchId > this.searchId) {
      this.#early.push(batch);
      return;
    }
    if (batch.searchId !== this.searchId) return;
    // a loop, not `push(...entries)`: a spread of a huge batch overflows the call stack
    for (const e of batch.entries) this.#results.push(e);
    this.scanned = batch.scanned;
    if (batch.error) this.error = batch.error;
    const finished = batch.done || batch.cancelled;
    if (finished) this.running = false;
    if (batch.entries.length > 0 || finished) this.#announce(finished);
  }

  /** Subscribe to the results event; returns the detach fn. */
  attach() {
    const unlisten = onSearchResults((b) => this.apply(b));
    return () => void unlisten.then((f) => f());
  }

  /** Does this search belong where the active tab is now? */
  belongsTo(location: Location) {
    return sameLocation(this.location, location);
  }

  /**
   * Search for `text` under the active tab's folder — or every drive, from a place — dropping
   * any search still running.
   */
  async start(text: string) {
    const generation = ++this.#generation;
    const current = () => generation === this.#generation;
    await this.cancel();
    const location = tabs.active.location;
    const roots = tabs.active.isFolder ? [tabs.active.path] : await placeRoots();
    if (!current()) return;
    this.text = text;
    this.location = location;
    this.roots = roots;
    this.query = parseQuery(text, this.chips);
    this.#retire();
    this.scanned = 0;
    this.error = null;
    this.active = true;
    this.running = true;
    // a name-only query is answered from the index, scoped to the folders searched; any filter,
    // an index still building (or failing), or roots it does not cover keep the walker
    if (isNameOnly(this.query)) {
      const hits = await this.#fromIndex(this.query.text, roots);
      if (!current()) return;
      if (hits) {
        this.running = false;
        this.#results = hits;
        this.scanned = hits.length;
        this.#announce(true);
        return;
      }
    }
    this.#starting = true;
    let id: number;
    try {
      id = await startSearch(this.roots, this.query, settings.showHidden);
    } catch (e) {
      if (!current()) return;
      this.error = String(e);
      this.running = false;
      return;
    } finally {
      // the newer start owns `#starting` and will lower it itself
      if (current()) this.#starting = false;
    }
    if (!current()) {
      // superseded while Rust was answering: this search is ours alone — `cancel` only knows
      // `searchId`, so nobody else would ever stop it
      void cancelSearch(id).catch(() => {});
      return;
    }
    this.searchId = id;
    // from here the exact-match check refuses the old ids; a floor kept would only risk
    // refusing the new ones if Rust ever restarted its counter
    this.#staleUpTo = 0;
    const early = this.#early;
    this.#early = [];
    for (const b of early) this.apply(b);
  }

  /** Index hits under `roots`, or null when the index cannot answer this search. */
  async #fromIndex(text: string, roots: string[]): Promise<FileEntry[] | null> {
    try {
      const a = await indexSearch(text, INDEX_MAX);
      if (!a || !a.ready || a.roots.length === 0) return null;
      // a cut list is never shown as the whole answer: the walker finds the rest
      if (a.total > a.hits.length) return null;
      if (!roots.every((r) => a.roots.some((ir) => under(r, ir)))) return null;
      return a.hits.filter(
        (h) => (settings.showHidden || !h.isHidden) && roots.some((r) => under(h.path, r)),
      );
    } catch {
      return null;
    }
  }

  /** The chips changed: the same text again with the new filters. */
  restart() {
    if (this.active) void this.start(this.text);
  }

  /** Stop a running search; what arrived stays listed. */
  async cancel() {
    if (!this.running) return;
    this.running = false;
    const id = this.searchId;
    if (id > 0) await cancelSearch(id).catch(() => {});
  }

  /** Back to the folder: nothing searched, chips reset. A start still in flight is dropped too. */
  clear() {
    // the start in flight is now superseded, so it will not lower `#starting` or drain `#early`
    // itself — nothing owns them until the next start, and a dead search must not fill the buffer
    this.#generation++;
    this.#starting = false;
    this.#early = [];
    void this.cancel();
    this.active = false;
    this.text = '';
    this.chips = emptyChips();
    this.query = NO_QUERY;
    this.#retire();
    this.scanned = 0;
    this.error = null;
  }
}

export const search = new SearchState();
