// Explorer's "File name extensions" off: a file shows without its last extension. Pure, so the
// rules are tested once here; `data/display-name` applies the setting. ⚠️ No `state/settings`
// import: `data/file-columns` imports this and `state/settings` imports file-columns.
import type { FileEntry } from '$lib/types/fs';
import { shownName } from './app-bundle';

/**
 * `name` without its last extension, as Explorer hides it: `report.pdf` → `report`,
 * `archive.tar.gz` → `archive.tar` (only the last one). A name whose only dot leads it
 * (`.bashrc`), ends it (`notes.`) or that has none is returned whole — there is no extension
 * to take, and an empty label is never the answer.
 */
export const stripExtension = (name: string): string => {
  const dot = name.lastIndexOf('.');
  return dot <= 0 || dot === name.length - 1 ? name : name.slice(0, dot);
};

/**
 * The name a row SHOWS: a Mac app bundle loses `.app` (`shownName`), and with extensions off a
 * FILE loses its last extension. A folder keeps its whole name: `v1.2` is a folder's name, not a
 * folder with a `.2` extension. Display only — `entry.name` stays the real name.
 */
export const nameLabel = (entry: Pick<FileEntry, 'isDir' | 'name'>, showExtensions: boolean) => {
  const name = shownName(entry);
  return showExtensions || entry.isDir ? name : stripExtension(name);
};
