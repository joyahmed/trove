// What Cut / Copy put aside, shared across tabs. Mirrored to the OS clipboard as CF_HDROP so
// Explorer can paste what we copied; `read` asks the OS clipboard first so Ctrl+V works the
// other way too, and a copy made elsewhere since beats our old list. Cut rows render dimmed
// until they are pasted, or until the OS clipboard no longer holds them.
import { clipboardReadPaths, clipboardWritePaths } from '$lib/api/clipboard';
import type { ClipboardPaths } from '$lib/types/transfer';
import { logError } from '$lib/api/log';

const same = (a: string[], b: string[]) => a.length === b.length && a.every((p, i) => p === b[i]);

/** Entries copied from inside an archive (plan 16, Phase 4): no real paths, so a paste
 * extracts them. `entries` are full inner paths (`docs/a.txt`). */
export interface ArchiveClip {
  archive: string;
  entries: string[];
}

class ClipboardState {
  paths = $state<string[]>([]);
  cut = $state(false);
  /** Copy inside an archive: set instead of `paths`, never written to the OS clipboard. */
  archive = $state.raw<ArchiveClip | null>(null);
  /** the OS clipboard took our list; if it refused, we are the only holder and cannot be stale */
  private mirrored = false;
  /** the OS clipboard's files when `archive` was set: a change since means it moved on */
  private osAtArchive: string[] | null = null;

  has = $derived(this.paths.length > 0);

  /** Take these paths; `cut` marks them for a move on paste. */
  set(paths: string[], cut: boolean) {
    this.archive = null;
    this.osAtArchive = null;
    this.paths = [...paths];
    this.cut = cut;
    this.mirrored = false;
    // best effort: the OS clipboard is a convenience for other apps, never a blocker here
    clipboardWritePaths(this.paths, cut).then(
      () => {
        if (same(this.paths, paths)) this.mirrored = true;
      },
      () => {},
    );
  }

  clear() {
    this.paths = [];
    this.cut = false;
    this.mirrored = false;
    this.archive = null;
    this.osAtArchive = null;
  }

  /**
   * Copy inside an archive: hold the entries for a paste (which extracts them). Our `paths`
   * empty, and nothing goes to the OS clipboard — there is no real file to give it.
   */
  setArchive(archive: string, entries: string[]) {
    this.clear();
    const clip = { archive, entries: [...entries] };
    this.archive = clip;
    void this.osFiles().then((os) => {
      if (this.archive === clip && os !== undefined) this.osAtArchive = os?.paths ?? [];
    });
  }

  /**
   * The archive entries to paste, or null. ⚠️ Ask this BEFORE `read()`: `read` returns the OS
   * clipboard whenever `paths` is empty. A file copy made elsewhere since the archive copy wins:
   * the archive clip is dropped and null comes back, so `read()` then finds that copy.
   */
  async readArchive(): Promise<ArchiveClip | null> {
    const clip = this.archive;
    if (!clip) return null;
    const seen = this.osAtArchive;
    if (seen !== null) {
      const os = await this.osFiles();
      if (os !== undefined && !same(os?.paths ?? [], seen)) {
        if (this.archive === clip) this.clear();
        return null;
      }
    }
    return clip;
  }

  isCut = (path: string) => this.cut && this.paths.includes(path);

  /** The OS clipboard's file list; null for none; undefined when it could not be asked. */
  private async osFiles(): Promise<ClipboardPaths | null | undefined> {
    try {
      const os = await clipboardReadPaths();
      return os && os.paths.length > 0 ? os : null;
    } catch (e) {
      logError('clipboard.readOsClipboard', e);
      return undefined;
    }
  }

  /**
   * Ours is only good while the OS clipboard still holds the same list: Explorer, "Copy as path"
   * or a text copy replaces it, and then our old list is a ghost. Un-dims cut rows then.
   */
  async verify() {
    if (!this.has || !this.mirrored) return;
    const os = await this.osFiles();
    if (os === undefined) return;
    if (!os || !same(os.paths, this.paths)) this.clear();
  }

  /** The OS clipboard's files if it changed since we wrote, else ours; null for nothing. */
  async read(): Promise<ClipboardPaths | null> {
    const os = await this.osFiles();
    if (this.has) {
      if (os === undefined || !this.mirrored || (os && same(os.paths, this.paths))) {
        return { paths: [...this.paths], cut: this.cut };
      }
      this.clear(); // the OS clipboard moved on: ours is stale
    }
    return os ?? null;
  }
}

export const clipboard = new ClipboardState();

// coming back from Explorer is when a cut / copy there can have replaced ours
if (typeof window !== 'undefined') {
  window.addEventListener('focus', () => void clipboard.verify());
}
