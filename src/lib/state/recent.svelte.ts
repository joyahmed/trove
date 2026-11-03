// Recent things, two kinds: the folders this app visited (ours, kept in settings) and the files
// the OS saw opened (Windows' Recent shortcuts, Ubuntu's recently-used.xbel; none on a Mac yet). Home's Recent
// section shows both, folders first, as the palette's RECENT group does.
import { recentFiles as fetchRecentFiles } from '$lib/api/recent';
import { places } from '$lib/state/places.svelte';
import { settings } from '$lib/state/settings.svelte';
import type { FileEntry } from '$lib/types/fs';
import { logError } from '$lib/api/log';
import { folderKey, isDriveRoot, samePath } from '$lib/utils/path';

/** How many visited folders survive; Quick access and Home show fewer. */
export const MAX_RECENT_FOLDERS = 12;

class RecentState {
  /** The OS's recent files, newest first; loaded when Home shows. Empty on a Mac. */
  files = $state.raw<FileEntry[]>([]);
  loading = $state(false);

  /**
   * Visited folders that are not already on Home as a pin, a known folder or a drive, most
   * recent first.
   * A drive has its own tile under This PC; `/` and a drive root are dropped by name too
   * because the drives list can land late on Linux. Drives match by `folderKey`, so `/media/x/`
   * is the drive `/media/x` — and on Linux `/media/X` is not. `settings.recentFolders` keeps
   * them all — the palette and history use it.
   */
  folders = $derived.by(() => {
    const listed = [...settings.pins, ...places.knownFolders.map((f) => f.path)];
    const drives = new Set(places.drives.map((d) => folderKey(d.path)));
    return settings.recentFolders.filter(
      (p) =>
        p !== '/' &&
        !isDriveRoot(p) &&
        !drives.has(folderKey(p)) &&
        !listed.some((l) => samePath(l, p)),
    );
  });

  /** A folder was listed: it moves to the front; the list stays at `MAX_RECENT_FOLDERS`. */
  visited(path: string) {
    if (!path) return;
    const rest = settings.recentFolders.filter((p) => !samePath(p, path));
    settings.recentFolders = [path, ...rest].slice(0, MAX_RECENT_FOLDERS);
  }

  /** Drop a folder from the list; a path that is not in it writes nothing. */
  forget(path: string) {
    if (!settings.recentFolders.some((p) => samePath(p, path))) return;
    settings.recentFolders = settings.recentFolders.filter((p) => !samePath(p, path));
  }

  /**
   * Which fetch is the current one. Home re-fetches every time it shows — the effect in
   * `use-place-view` runs again on every tab switch and navigation back to Home, and F5 asks
   * again — and reading Windows' Recent folder means resolving every shortcut, so two fetches
   * overlap easily and nothing makes them answer in the order they were started. The stale one
   * landing last puts back an older list; worse, a stale *failure* empties Home of the files the
   * live fetch has already found.
   */
  #generation = 0;

  async loadFiles() {
    const generation = ++this.#generation;
    const current = () => generation === this.#generation;
    this.loading = true;
    try {
      const files = await fetchRecentFiles();
      if (!current()) return;
      this.files = files;
    } catch (e) {
      logError('recent.fetchRecentFiles', e);
      if (!current()) return;
      this.files = [];
    } finally {
      // the newer fetch owns `loading` and will lower it
      if (current()) this.loading = false;
    }
  }
}

export const recent = new RecentState();
