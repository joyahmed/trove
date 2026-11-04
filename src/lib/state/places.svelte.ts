// What the sidebar and the Home / This PC views list: known folders, drives and the OneDrive
// root, loaded once from the OS; `reload` re-asks (F5 on a place, a drive plugged in).
//
// ⛔ **The sources load independently, and that is the whole point of this file.** It used to be
// one `Promise.all` over all three, which meant This PC painted nothing until the *slowest* one
// landed — and `trove.log` measured `drives` at 21 s on one cold start and **64 s** on the next,
// because one drive letter is a dead network mapping and the SMB redirector waits it out. A
// minute of empty pane is what "This PC showed nothing and no folder no device and drives" was.
// `docs/plans/07-the-log-and-four-bugs.md` Phase C.
//
// ⛔ `Promise.allSettled` would NOT have fixed that: it still waits for the slowest before
// anything is assigned. Each source has to write its own field the moment it resolves.
//
// ⛔ And a failed source must never look like an empty one. `.catch(() => [])` would turn "the
// OS call failed" into "you own no drives" — the same silent blank pane in a new costume, and
// the reported bug would have survived its own fix. Failure goes in `drivesError` /
// `foldersError` and stays distinguishable all the way to the view.
//
// ⛔ And because a source can stay outstanding for a minute, **two runs of it overlap routinely** —
// F5 on This PC, the "Try again" under a section, a palette query, any of them while the first
// enumeration is still waiting on the SMB redirector. So every write below an `await` belongs to
// one generation of one source and is skipped once a newer run of that source has started.
// Without that the 64-second call lands last and wins: yesterday's drive list, a spinner lowered
// while a call is still running, and — the bad one — `loaded` latched `true` with the error wiped,
// which takes the "Try again" button off the screen *and* makes `load()` skip for the session.
import {
  drives as fetchDrives,
  knownFolders as fetchKnownFolders,
  oneDriveRoot as fetchOneDriveRoot,
} from '$lib/api/shell';
import { cloudSyncStatus } from '$lib/api/fs';
import { logError } from '$lib/api/log';
import { network } from '$lib/state/network.svelte';
import type { SyncStatus } from '$lib/types/fs';
import type { DriveInfo, KnownFolder } from '$lib/types/shell';

class PlacesState {
  knownFolders = $state<KnownFolder[]>([]);
  drives = $state<DriveInfo[]>([]);
  /** `C:\Users\alex\OneDrive` when the client is set up; null otherwise */
  oneDriveRoot = $state<string | null>(null);
  /** the OneDrive client's sync state for its root (the sidebar row's glyph); null when it says none */
  oneDriveSync = $state<SyncStatus | null>(null);

  /**
   * Where `FOLDERID_Downloads` actually is; null until the folders land (see the note above —
   * that can be seconds) or when the call failed.
   *
   * ⚠️ This is the only honest way to know a folder is *the* Downloads folder, which the
   * per-folder view seed depends on (`utils/folder-views`): matching the NAME would group a
   * `D:\Downloads` of your own and would miss a Downloads folder that has been moved.
   */
  downloadsPath = $derived(this.knownFolders.find((f) => f.key === 'downloads')?.path ?? null);

  /**
   * Per source, because they arrive as much as a minute apart. A view that shows one spinner
   * for "places" would spin for the whole minute over folders that arrived in one second.
   */
  foldersLoading = $state(false);
  drivesLoading = $state(false);
  foldersError = $state<string | null>(null);
  drivesError = $state<string | null>(null);

  /**
   * Every source has had a turn and none of them failed.
   *
   * ⛔ Not set when a source failed — `load()` skips on it, so marking a half-failed load as
   * loaded would make the gap permanent for the session, with nothing left to re-ask.
   *
   * ⛔ Derived from `#foldersOk` / `#drivesOk` and nothing else. It used to be computed in
   * `reload()` from `foldersError` / `drivesError`, which are *shared* fields a concurrent run
   * may have just rewritten — so a superseded run that resolved last set `loaded` from the other
   * run's outcome. That is the latch this file must never have: `load()` skips on `loaded`, and
   * the section's "Try again" only renders while its error is non-null, so `loaded = true` with
   * the error cleared by a stale success leaves the stale list on screen with nothing at all,
   * anywhere, that will ask again.
   */
  loaded = $state(false);

  /**
   * Whether the most recent *current* run of each source succeeded. Written only under the
   * generation guard, so no superseded run can contribute to `loaded`.
   */
  #foldersOk = false;
  #drivesOk = false;

  #syncLoaded() {
    this.loaded = this.#foldersOk && this.#drivesOk;
  }

  /**
   * One generation per source, deliberately not one for the file: `retryDrives()` must not
   * invalidate a `reload()`'s folders call that is still in flight, or the Folders section would
   * be left empty with a spinner no one is left to lower.
   */
  #foldersGeneration = 0;
  #drivesGeneration = 0;
  #oneDriveGeneration = 0;

  /**
   * ⛔ Do not remove this guard to force retries. It is what stops This PC re-enumerating every
   * drive on every navigation, and enumeration costs a thread per letter and up to a minute.
   */
  load() {
    return this.loaded ? Promise.resolve() : this.reload();
  }

  /**
   * ⚠️ **Never rejects.** Every failure lands in a per-source error field instead, so callers
   * cannot silently drop one: `use-shell`'s startup effect used to `void` this and lose the
   * rejection entirely, and `tab.refresh()` wrapped it in `try/finally` with no `catch`, which
   * stopped the spinner and said nothing. Keep that contract if this is changed.
   */
  async reload() {
    // ⛔ Nothing is assigned here. Each loader maintains its own field, its own error, its own
    // spinner and its own half of `loaded`, under its own generation guard — a `reload` that has
    // been overtaken must not get a say in any of it just because it resolved last.
    await Promise.allSettled([this.#loadFolders(), this.#loadDrives(), this.#loadOneDrive()]);
  }

  async #loadFolders() {
    const generation = ++this.#foldersGeneration;
    const current = () => generation === this.#foldersGeneration;
    this.foldersLoading = true;
    try {
      const folders = await fetchKnownFolders();
      if (!current()) return;
      this.knownFolders = folders;
      this.foldersError = null;
      this.#foldersOk = true;
    } catch (e) {
      logError('places.knownFolders', e);
      if (!current()) return;
      this.foldersError = String(e);
      this.#foldersOk = false;
    } finally {
      // The newer run owns the spinner and will lower it; a superseded run must leave it up.
      if (current()) {
        this.foldersLoading = false;
        this.#syncLoaded();
      }
    }
  }

  async #loadDrives() {
    const generation = ++this.#drivesGeneration;
    const current = () => generation === this.#drivesGeneration;
    this.drivesLoading = true;
    // which letters are mapped shares: one cheap OS read, beside the drives, for the Network group
    void network.loadMapped();
    try {
      const drives = await fetchDrives();
      if (!current()) return;
      this.drives = drives;
      this.drivesError = null;
      this.#drivesOk = true;
    } catch (e) {
      logError('places.drives', e);
      if (!current()) return;
      this.drivesError = String(e);
      this.#drivesOk = false;
    } finally {
      if (current()) {
        this.drivesLoading = false;
        this.#syncLoaded();
      }
    }
  }

  /** The one source whose absence is normal: no OneDrive client is not a failure. */
  async #loadOneDrive() {
    const generation = ++this.#oneDriveGeneration;
    const current = () => generation === this.#oneDriveGeneration;
    try {
      const root = await fetchOneDriveRoot();
      if (current()) this.oneDriveRoot = root;
      // the glyph is decoration: a failure leaves the row as it was, without one
      const sync = root ? await cloudSyncStatus(root).catch(() => null) : null;
      if (current()) this.oneDriveSync = sync;
    } catch (e) {
      logError('places.oneDriveRoot', e);
      if (current()) this.oneDriveRoot = null;
    }
  }

  /**
   * The Devices and drives section only — the retry behind its error message. A retry that
   * succeeds also clears this source's half of `loaded`'s condition, so a session that recovered
   * from a failed drive enumeration stops re-enumerating on every `load()`.
   */
  retryDrives() {
    return this.#loadDrives();
  }

  /** The Folders section only. */
  retryFolders() {
    return this.#loadFolders();
  }
}

export const places = new PlacesState();
