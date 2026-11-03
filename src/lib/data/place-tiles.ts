// What each place shows, as data: Home is Quick access (known folders, pins) and Recent (the
// folders Trove visited, then the files the OS saw opened); This PC is the known folders and
// every drive. `tiles` closures read `places` / `settings` live, so the view follows them the
// way the sidebar's sections do.
import type { GlyphName } from '$lib/data/glyphs';
import { folderIcon, knownFolderIcons } from '$lib/data/known-folder-icons';
import { places } from '$lib/state/places.svelte';
import { recent } from '$lib/state/recent.svelte';
import { settings } from '$lib/state/settings.svelte';
import type { FileEntry } from '$lib/types/fs';
import type { PlaceKind } from '$lib/types/location';
import type { DriveInfo, KnownFolder } from '$lib/types/shell';
import { fmtSpace } from '$lib/utils/format';
import { onWindows } from '$lib/utils/platform';
import { locationLabel, pathLocation } from '$lib/utils/location';

export type PlaceTile =
  | { kind: 'folder'; key: string; label: string; path: string; glyph: GlyphName; color: string }
  /** one of the OS's recent files; opens with its default app */
  | { kind: 'file'; key: string; path: string; entry: FileEntry }
  | {
      kind: 'drive';
      key: string;
      /** "Local Disk (C:)" */
      label: string;
      path: string;
      /** 0…1 of the volume in use; null when the size is unknown (no bar) */
      usedFraction: number | null;
      /** "45.3 GB free of 237 GB"; null when the size is unknown (no caption) */
      caption: string | null;
      /** Explorer paints the bar red past 90 % used */
      critical: boolean;
    };

/**
 * Whether a section that has to ask the OS is still asking, or failed.
 *
 * ⛔ The three states must stay distinguishable: **none**, **still asking** and **could not
 * ask**. Collapsing "could not ask" into "none" is the bug this exists to prevent — an empty
 * pane that means nothing, which is what This PC showed. And "still asking" is not cosmetic:
 * `drives` has been measured at 64 s on a cold start, so a section with no tiles yet is the
 * normal case for a minute, not an error.
 */
export interface SectionStatus {
  loading: boolean;
  error: string | null;
  retry: () => void;
}

export interface PlaceSection {
  key: string;
  title: string;
  tiles: () => PlaceTile[];
  /** Only sections that ask the OS have one; Quick access and Recent do not. */
  status?: () => SectionStatus;
}

const CRITICAL_USED = 0.9;

export const driveTile = (d: DriveInfo): PlaceTile => {
  // ⛔ Unknown is not zero: a failed size query shows nothing, never "0 B free of 0 B" (B.2.4).
  const { totalBytes, freeBytes } = d;
  const sized = totalBytes != null && freeBytes != null && totalBytes > 0;
  const usedFraction = sized ? (totalBytes - freeBytes) / totalBytes : null;
  return {
    kind: 'drive',
    key: d.path,
    label: onWindows() ? `${d.label} (${d.path.slice(0, 2)})` : d.label || d.path,
    path: d.path,
    usedFraction,
    caption: sized ? `${fmtSpace(freeBytes)} free of ${fmtSpace(totalBytes)}` : null,
    critical: usedFraction !== null && usedFraction >= CRITICAL_USED,
  };
};

export const knownFolderTile = (f: KnownFolder): PlaceTile => ({
  kind: 'folder',
  key: f.key,
  label: f.label,
  path: f.path,
  ...knownFolderIcons[f.key],
});

/** Home's Recent lists this many visited folders before the recent files. */
export const HOME_RECENT_FOLDERS = 8;

export const pinTile = (path: string): PlaceTile => ({
  kind: 'folder',
  key: `pin:${path}`,
  label: locationLabel(pathLocation(path)),
  path,
  ...folderIcon,
});

export const recentFolderTile = (path: string): PlaceTile => ({
  kind: 'folder',
  key: `rec:${path}`,
  label: locationLabel(pathLocation(path)),
  path,
  ...folderIcon,
});

export const fileTile = (entry: FileEntry): PlaceTile => ({
  kind: 'file',
  key: `file:${entry.path}`,
  path: entry.path,
  entry,
});

const knownFolderTiles = () => places.knownFolders.map(knownFolderTile);
/** Quick access lists only the built-ins the person has not unpinned; This PC lists them all. */
const quickAccessKnownTiles = () =>
  places.knownFolders.filter((f) => !settings.isKnownFolderHidden(f.key)).map(knownFolderTile);

/** Pins that are not already listed as a known folder. */
const pinTiles = () => {
  const known = new Set(places.knownFolders.map((f) => f.path));
  return settings.pins.filter((p) => !known.has(p)).map(pinTile);
};

export const placeSections: Record<PlaceKind, PlaceSection[]> = {
  home: [
    {
      key: 'quick-access',
      title: 'Quick access',
      tiles: () => [...quickAccessKnownTiles(), ...pinTiles()],
    },
    /*
     * ⛔ Recent is ours AND the OS's, folders first — the same two lists, in the same order, as
     * the palette's RECENT group (`palette-sources` recentSource). It used to be the OS's recent
     * files only, with our visited folders up in Quick access, so on a Mac (no OS source) Home
     * said "Recent (0)" while ⌘K listed folders under RECENT (Mac, 2026-10-06).
     */
    {
      key: 'recent',
      title: 'Recent',
      tiles: () => [
        ...recent.folders.slice(0, HOME_RECENT_FOLDERS).map(recentFolderTile),
        ...recent.files.map(fileTile),
      ],
    },
  ],
  'this-pc': [
    {
      key: 'folders',
      title: 'Folders',
      tiles: knownFolderTiles,
      status: () => ({
        loading: places.foldersLoading,
        error: places.foldersError,
        retry: () => void places.retryFolders(),
      }),
    },
    {
      key: 'drives',
      title: 'Devices and drives',
      tiles: () => places.drives.map(driveTile),
      // ⚠️ The slow one, by a wide margin — a dead network mapping makes this a minute.
      status: () => ({
        loading: places.drivesLoading,
        error: places.drivesError,
        retry: () => void places.retryDrives(),
      }),
    },
  ],
  // Gallery, Applications and the Recycle Bin are their own views, not tiles
  gallery: [],
  applications: [],
  'recycle-bin': [],
};

/** How many tiles a place shows — the status bar's "n items". */
export const placeTileCount = (kind: PlaceKind) =>
  placeSections[kind].reduce((n, s) => n + s.tiles().length, 0);
