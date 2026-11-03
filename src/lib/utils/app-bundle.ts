// A macOS app is a folder named `Something.app` (a "bundle"). Finder launches it on a
// double-click instead of opening it; Trove does the same, and calls it "App" with the app
// glyph. Only on a Mac: on Windows and Linux a folder named `x.app` is just a folder.
import type { FileEntry } from '$lib/types/fs';
import { onMac } from './platform';

type Platform = Parameters<typeof onMac>[0];

/** A folder ending in `.app` on a Mac. Off Tauri (tests, a browser) nothing is injected: false. */
export const isAppBundle = (
  entry: Pick<FileEntry, 'isDir' | 'name'>,
  platform?: Platform,
): boolean =>
  entry.isDir &&
  entry.name.length > '.app'.length &&
  entry.name.toLowerCase().endsWith('.app') &&
  onMac(platform);

/** A folder you go INTO: every directory except a Mac's app bundle. New tab / window, pin and
 *  "drop into" are for these only — a drop on `Foo.app` would write inside the bundle. */
export const opensAsFolder = (
  entry: Pick<FileEntry, 'isDir' | 'name'>,
  platform?: Platform,
): boolean => entry.isDir && !isAppBundle(entry, platform);

/** The `data-drop` path a row offers: a folder's own path, nothing for a file or an app — and
 * nothing for a folder inside an archive (its path holds a NUL; archives are read-only). */
export const dropPathOf = (
  entry: Pick<FileEntry, 'isDir' | 'name' | 'path'>,
  platform?: Platform,
): string | undefined =>
  opensAsFolder(entry, platform) && !entry.path.includes('\u0000') ? entry.path : undefined;

/** The name a row SHOWS: Finder hides `.app` on a bundle ("Safari", not "Safari.app"). Display
 *  only — the real name stays in `entry.name` for paths, rename and every operation. */
export const shownName = (entry: Pick<FileEntry, 'isDir' | 'name'>, platform?: Platform): string =>
  isAppBundle(entry, platform) ? entry.name.slice(0, -'.app'.length) : entry.name;
