// What Settings → Search index shows that is not a saved setting: the drives the index could
// walk, and how big its saved files are. Loaded when the section opens (`refresh`), kept here so
// the section's rows read it live.
import { indexDiskSize, indexDrives, indexForget } from '$lib/api/index-settings';

/** "12.4 MB", "830 KB", "0 B" — what the size note says. */
export const formatBytes = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
};

class IndexSettingsState {
  /** drive roots (`C:\`), from the host */
  drives = $state.raw<string[]>([]);
  /** bytes on disk; null until the first answer */
  size = $state<number | null>(null);

  #asked = false;

  /** Load once, the first time the section is drawn; later opens keep the answer. */
  ensureLoaded() {
    if (this.#asked) return;
    this.#asked = true;
    void this.refresh();
  }

  async refresh() {
    try {
      const [drives, size] = await Promise.all([indexDrives(), indexDiskSize()]);
      this.drives = drives.map((d) => d.root);
      this.size = size;
    } catch {
      // keep what we had: the section then shows its last answer rather than an error
    }
  }

  /** Delete the saved files. Returns the bytes freed, or null when it failed. */
  async forget(): Promise<number | null> {
    try {
      const freed = await indexForget();
      this.size = 0;
      return freed;
    } catch {
      return null;
    }
  }

  get sizeLabel(): string | null {
    return this.size === null ? null : `Saved on disk: ${formatBytes(this.size)}`;
  }
}

export const indexSettings = new IndexSettingsState();
