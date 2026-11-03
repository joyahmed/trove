// The Recycle Bin as a place: its items newest first, a selection of its own (the tab
// selection is for folder rows), and restore / purge / empty — each re-lists afterwards.
import { SvelteSet } from 'svelte/reactivity';
import { recycleEmpty, recycleList, recyclePurge, recycleRestore } from '$lib/api/recycle';
import type { RecycleItem } from '$lib/types/recycle';
import { sameListing } from '$lib/utils/bin-poll';

class RecycleState {
  /** Replaced wholesale by every listing. */
  items = $state.raw<RecycleItem[]>([]);
  loading = $state(false);
  loaded = $state(false);
  error = $state<string | null>(null);
  /** selected item ids */
  selected = new SvelteSet<string>();

  count = $derived(this.items.length);

  /**
   * Entering the bin reads it again — files are deleted from everywhere else in the app while
   * this view is gone, so the last listing is only a guess. `loaded` no longer skips the read;
   * it only says whether this is the first one, and so whether the view may show
   * "Looking in the Recycle Bin…" or must re-read silently behind the rows on screen.
   */
  async load() {
    await this.#read({ silent: this.loaded });
  }

  /** F5, and the re-list after every operation: the list may blank while it is read. */
  async reload() {
    await this.#read({ silent: false });
  }

  /**
   * The open view's timer read (`startBinPoll`): picks up what was binned or restored outside
   * Trove. Quieter than a silent read — it never touches `error` (an operation's message must
   * not vanish two seconds later, and a passing failure is F5's to report), and a listing that
   * draws the same rows leaves `items` as it is, so nothing re-renders. Before the first read
   * there is nothing on screen to keep current.
   */
  async poll() {
    if (!this.loaded) return;
    await this.#read({ silent: true, quiet: true });
  }

  /**
   * How many items the bin holds **now**, having just re-read it — not what the last listing
   * left behind. Explorer counts at the moment it asks you, and `empty()` purges whatever is in
   * the bin when it runs, so a confirmation built on a stale count understates a destructive
   * action. Silent once the first read is done, so nothing flickers behind the dialog.
   */
  async countNow() {
    await this.#read({ silent: this.loaded });
    return this.count;
  }

  /**
   * Which read is the current one. Reads overlap in ordinary use — entering the view, F5, the
   * re-list after an operation, and now the count taken before a confirmation — and nothing
   * makes them resolve in the order they were started, so without this a slow earlier read
   * lands last and overwrites the newer answer with items that are already gone.
   */
  #generation = 0;

  /**
   * The newest read that must not clear an operation's error. `#run` sets it to whatever reads
   * exist when it reports a failure: every one of them was started before the person could have
   * been told, so none of them is allowed to answer last and take the message away. A read
   * started afterwards — F5, a re-entry — is the person asking again, and may clear it.
   */
  #errorFloor = 0;

  /**
   * Read the bin. `silent` is `TabState.reload`'s contract, for the same reason: `loading` is
   * never raised, so nothing flashes over rows that are already there, and a read that fails
   * leaves those rows alone with the error beside them.
   *
   * A read that has been superseded writes nothing at all — not the items, not the error, not
   * `loading` (the newer read owns it and will lower it).
   */
  async #read({ silent, quiet = false }: { silent: boolean; quiet?: boolean }) {
    const generation = ++this.#generation;
    const current = () => generation === this.#generation;
    if (!silent) {
      this.loading = true;
      this.error = null;
    }
    try {
      const items = await recycleList();
      if (!current()) return;
      if (!quiet || !sameListing(this.items, items)) this.items = items;
      if (!quiet && generation > this.#errorFloor) this.error = null;
      this.loaded = true;
      // a selection that outlived its items is dropped
      for (const id of [...this.selected]) {
        if (!items.some((i) => i.id === id)) this.selected.delete(id);
      }
    } catch (e) {
      if (!current() || quiet) return;
      this.error = String(e);
    } finally {
      if (!silent && current()) this.loading = false;
    }
  }

  isSelected = (id: string) => this.selected.has(id);

  select(id: string, { ctrl = false } = {}) {
    if (!ctrl) this.selected.clear();
    if (ctrl && this.selected.has(id)) this.selected.delete(id);
    else this.selected.add(id);
  }

  selectAll() {
    for (const i of this.items) this.selected.add(i.id);
  }

  clearSelection() {
    this.selected.clear();
  }

  /** Put the items back where they came from. */
  async restore(ids: string[]) {
    if (ids.length === 0) return;
    await this.#run(() => recycleRestore(ids));
  }

  /** Delete the items for good. */
  async purge(ids: string[]) {
    if (ids.length === 0) return;
    await this.#run(() => recyclePurge(ids));
  }

  /** Delete everything for good. */
  async empty() {
    await this.#run(recycleEmpty);
  }

  /**
   * Run an operation, then re-list; the operation's error outlives the re-list — and every other
   * read that was already in flight when it was reported (see `#errorFloor`).
   */
  async #run(op: () => Promise<void>) {
    let failed: string | null = null;
    try {
      await op();
    } catch (e) {
      failed = String(e);
    }
    await this.reload();
    if (failed !== null) {
      this.#errorFloor = this.#generation;
      this.error = failed;
    }
  }
}

export const recycle = new RecycleState();
