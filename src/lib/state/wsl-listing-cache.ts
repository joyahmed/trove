// The last listing seen per WSL folder. A `read_dir` over 9P costs hundreds of ms on a big
// folder, and Linux inotify never reaches us, so WSL tabs are re-read on a 5 s poll and on
// focus (`watcher.svelte.ts`). The cache lets a folder you go back to paint at once, and lets
// the poll keep the rows it already has when nothing changed (no re-render, no lost hover).
import type { FileEntry } from '$lib/types/fs';

/** Folders kept; the oldest visit drops first. A big WSL folder is a few thousand rows. */
export const WSL_CACHE_SIZE = 32;

const listings = new Map<string, FileEntry[]>();

/** WSL paths are case-sensitive, so only the trailing separator is folded. */
const keyOf = (path: string) => path.replace(/[\\/]+$/, '');

export const wslListings = {
  get(path: string): FileEntry[] | undefined {
    const key = keyOf(path);
    const hit = listings.get(key);
    if (hit) {
      // a read counts as a visit: move it to the young end
      listings.delete(key);
      listings.set(key, hit);
    }
    return hit;
  },
  remember(path: string, entries: FileEntry[]) {
    const key = keyOf(path);
    listings.delete(key);
    listings.set(key, entries);
    while (listings.size > WSL_CACHE_SIZE) listings.delete(listings.keys().next().value!);
  },
  forget(path: string) {
    listings.delete(keyOf(path));
  },
  clear() {
    listings.clear();
  },
};

/** The fields a row shows; equal on all of them means the poll has nothing to paint. */
const sameEntry = (a: FileEntry, b: FileEntry) =>
  a.path === b.path &&
  a.isDir === b.isDir &&
  a.size === b.size &&
  a.modifiedMs === b.modifiedMs &&
  a.isHidden === b.isHidden;

/** Same rows in the same order (`read_dir` answers in one stable order for an unchanged folder). */
export const sameListing = (a: readonly FileEntry[], b: readonly FileEntry[]) =>
  a.length === b.length && a.every((e, i) => sameEntry(e, b[i]));
