// Mac: the privacy-guarded folders (Desktop, Documents, Downloads…) not opened in Trove yet,
// which every search leaves out (core/privacy_folders.rs), and the one act that opens them:
// Allow — each is read once, so macOS asks at a moment the person chose. Read by Settings ▸
// General and by the palette / search header's "Not searched … — Allow" row. Empty off a Mac.
import { allowGuardedFolders, unopenedGuardedFolders } from '$lib/api/fs';
import { logError } from '$lib/api/log';

class GuardedFoldersState {
  /** the folders still unopened; null until the first answer */
  unopened = $state.raw<string[] | null>(null);
  /** an Allow is waiting on macOS's prompts */
  busy = $state(false);

  #asked = false;

  /** Load once, the first time Settings draws the row; Allow keeps it current after that. */
  ensureLoaded() {
    if (this.#asked) return;
    this.#asked = true;
    void this.refresh();
  }

  async refresh() {
    try {
      this.unopened = await unopenedGuardedFolders();
    } catch (e) {
      logError('guardedFolders.refresh', e);
    }
  }

  /**
   * Read each of `paths` once (macOS asks for each) and remember the ones it let Trove into.
   * Resolves to the folders now opened; a second Allow while one waits does nothing.
   */
  async allow(paths: string[]): Promise<string[]> {
    if (this.busy || paths.length === 0) return [];
    this.busy = true;
    try {
      return await allowGuardedFolders(paths);
    } catch (e) {
      logError('guardedFolders.allow', e);
      return [];
    } finally {
      this.busy = false;
      await this.refresh();
    }
  }
}

export const guardedFolders = new GuardedFoldersState();
