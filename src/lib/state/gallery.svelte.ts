// What the Gallery shows: the photos and videos from Pictures, newest first, grouped by the
// month they were last modified. Loaded when Gallery shows; F5 asks again. The same grid is also
// a view mode of any folder (plan 15 G.52): `folderGalleryGroups` arranges a folder's own files
// for it, and `GallerySource` is what the grid reads either way.
import { galleryItems } from '$lib/api/gallery';
import { oneDriveRoot, knownFolders, userProfile } from '$lib/api/shell';
import { unwatchPath, watchPath } from '$lib/api/watch';
import type { FileEntry } from '$lib/types/fs';
import { extensionOf } from '$lib/utils/file-icon';
import { pathSep, samePath } from '$lib/utils/path';

/** A change burst in Pictures settles this long before the Gallery looks again. */
export const GALLERY_REFRESH_MS = 800;

// The words under a tile's glyph live in `utils/tile-label.ts`, shared with the file list.
export { tileLabel } from '$lib/utils/tile-label';

export interface GalleryGroup {
  /** `2026-09`, or `unknown` for items without a date (listed last) */
  key: string;
  /** "September 2026" */
  label: string;
  items: FileEntry[];
}

const monthLabel = new Intl.DateTimeFormat('en', { month: 'long', year: 'numeric' });

/** `2026-09` for a Unix-ms stamp, in local time — the lint wants no mutable Date in a rune module. */
const monthKey = (ms: number) => {
  const parts = new Intl.DateTimeFormat('en', { year: 'numeric', month: '2-digit' }).formatToParts(
    ms,
  );
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('year')}-${get('month')}`;
};

/** Group newest-first items by month, keeping their order; undated items go last. */
export const groupByMonth = (items: FileEntry[]): GalleryGroup[] => {
  const groups: GalleryGroup[] = [];
  const byKey: Record<string, GalleryGroup> = {};
  let unknown: GalleryGroup | null = null;
  for (const item of items) {
    if (item.modifiedMs === null) {
      unknown ??= { key: 'unknown', label: 'Unknown date', items: [] };
      unknown.items.push(item);
      continue;
    }
    const key = monthKey(item.modifiedMs);
    let g = byKey[key];
    if (!g) {
      g = { key, label: monthLabel.format(item.modifiedMs), items: [] };
      byKey[key] = g;
      groups.push(g);
    }
    g.items.push(item);
  }
  if (unknown) groups.push(unknown);
  return groups;
};

/**
 * What the Gallery counts as a photo or video, by extension — exactly
 * `src-tauri/src/core/gallery.rs` `GALLERY_EXTS` (a test reads that line), so a folder's Gallery
 * view picks out the same kinds the Pictures Gallery lists.
 */
export const GALLERY_EXTS: readonly string[] = [
  'jpg',
  'jpeg',
  'png',
  'gif',
  'webp',
  'bmp',
  'heic',
  'tif',
  'tiff',
  'mp4',
  'mov',
  'webm',
  'mkv',
  'avi',
  'm4v',
];

/** A photo or video the Gallery grid draws as a picture; a folder never is. */
export const isGalleryMedia = (entry: Pick<FileEntry, 'name' | 'isDir'>): boolean => {
  if (entry.isDir) return false;
  const ext = extensionOf(entry.name);
  return ext !== null && GALLERY_EXTS.includes(ext);
};

/** The heading over a folder's non-photo items in its Gallery view. */
export const OTHER_ITEMS_LABEL = 'Other items';

/**
 * A folder's files arranged for its Gallery view: the photos and videos newest first, grouped by
 * month like the Pictures Gallery, then everything else (folders, documents) as plain tiles under
 * one last heading in the folder's own order — still there to open, never mistaken for photos.
 */
export const folderGalleryGroups = (entries: FileEntry[]): GalleryGroup[] => {
  const media: FileEntry[] = [];
  const other: FileEntry[] = [];
  for (const e of entries) (isGalleryMedia(e) ? media : other).push(e);
  // newest first; undated last (`groupByMonth` keeps them in their own group at the end)
  media.sort((a, b) => (b.modifiedMs ?? 0) - (a.modifiedMs ?? 0));
  const groups = groupByMonth(media);
  if (other.length > 0) groups.push({ key: 'other', label: OTHER_ITEMS_LABEL, items: other });
  return groups;
};

/**
 * What the Gallery grid shows and how it refreshes — the Pictures listing, or one folder's files
 * (`folderGallerySource` in `use-gallery-view`). One grid, two feeds.
 */
export interface GallerySource {
  /** the accessible name of the grid */
  readonly label: string;
  readonly groups: GalleryGroup[];
  readonly count: number;
  readonly loading: boolean;
  readonly error: string | null;
  /** shown while the first listing is on its way */
  readonly loadingText: string;
  /** shown when there is nothing at all */
  readonly emptyText: string;
  /** whether a thumbnail's menu offers "Open file location" (a folder's items are already there) */
  readonly reveal: boolean;
  /** called when the grid mounts */
  load(): void;
  /** called when the grid unmounts */
  unload?(): void;
  /** F5 */
  reload(): void;
}

/** A thumbnail is a 160 px square; thumbnails sit 4 px apart (Tailwind `gap-1`). */
export const THUMB_PX = 160;
export const GAP_PX = 4;
/** A month heading: `mt-2` (8) + `h-8` (32) + `mb-1` (4). */
const HEADER_PX = 44;
/** Room under a month's last row (`pb-3`). */
const GROUP_END_PX = 12;

/** One line of the Gallery: a month heading, or a run of thumbnails. `top` is from the first line. */
export type GalleryLine =
  | { kind: 'header'; key: string; top: number; height: number; group: GalleryGroup }
  | { kind: 'photos'; key: string; top: number; height: number; items: FileEntry[] };

/** How many thumbnails fit across `width` px. */
export const columnsFor = (width: number) =>
  Math.max(1, Math.floor((width + GAP_PX) / (THUMB_PX + GAP_PX)));

/**
 * The Gallery as fixed-height lines, so only the ones near the viewport need to be in the DOM:
 * a few thousand photos used to be a few thousand `<img>`s mounted at once. Every height is
 * known up front (squares and headings), which is what makes this a sum rather than a measure.
 */
export const planGallery = (groups: GalleryGroup[], cols: number) => {
  const lines: GalleryLine[] = [];
  let top = 0;
  for (const group of groups) {
    lines.push({ kind: 'header', key: `h:${group.key}`, top, height: HEADER_PX, group });
    top += HEADER_PX;
    for (let i = 0; i < group.items.length; i += cols) {
      const last = i + cols >= group.items.length;
      const height = THUMB_PX + (last ? GROUP_END_PX : GAP_PX);
      lines.push({
        kind: 'photos',
        key: `${group.key}:${i}`,
        top,
        height,
        items: group.items.slice(i, i + cols),
      });
      top += height;
    }
  }
  return { lines, height: top };
};

/** The lines that touch `[scrollTop - overscan, scrollTop + viewport + overscan]`. */
export const linesInView = (
  lines: GalleryLine[],
  scrollTop: number,
  viewport: number,
  overscan = 480,
): GalleryLine[] => {
  const from = scrollTop - overscan;
  const to = scrollTop + viewport + overscan;
  // first line whose bottom edge is below `from`
  let lo = 0;
  let hi = lines.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (lines[mid].top + lines[mid].height <= from) lo = mid + 1;
    else hi = mid;
  }
  let end = lo;
  while (end < lines.length && lines[end].top < to) end++;
  return lines.slice(lo, end);
};

class GalleryState {
  /** Replaced wholesale per load — raw, thousands of entries are not proxied. */
  items = $state.raw<FileEntry[]>([]);
  loading = $state(false);
  loaded = $state(false);
  error = $state<string | null>(null);

  groups = $derived(groupByMonth(this.items));

  /** Load once per session; `reload` asks the OS again. */
  load() {
    return this.loaded ? Promise.resolve() : this.reload();
  }

  /**
   * Which listing is the current one. Two listings overlap in ordinary use — the effect on mount
   * and F5, or F5 twice — and a scan of Pictures takes long enough that nothing makes them
   * resolve in the order they were started. Without this an older scan lands last and puts back
   * the photos it found, with a failure of the newer scan cleared behind it and the spinner
   * already lowered over rows nobody asked for.
   *
   * A listing that has been superseded writes nothing at all — not the items, not the error, not
   * `loading` (the newer listing owns it and will lower it).
   */
  #generation = 0;

  async reload() {
    const generation = ++this.#generation;
    const current = () => generation === this.#generation;
    this.loading = true;
    this.error = null;
    try {
      const items = await galleryItems();
      if (!current()) return;
      this.items = items;
      this.loaded = true;
    } catch (e) {
      if (!current()) return;
      this.error = String(e);
    } finally {
      if (current()) this.loading = false;
    }
  }

  /** The Pictures folders being watched while the Gallery shows (Rust walks the same ones). */
  #roots: string[] = [];
  #timer: ReturnType<typeof setTimeout> | undefined;
  #watching = 0;

  /**
   * Watch the Pictures folders the way a folder tab is watched, so photos that come or go
   * show up without F5. Safe to call twice; `unwatch` ends it.
   */
  async watch() {
    const token = ++this.#watching;
    const [profile, known, oneDrive] = await Promise.all([
      userProfile().catch(() => null),
      knownFolders().catch(() => []),
      oneDriveRoot().catch(() => null),
    ]);
    if (token !== this.#watching) return;
    const candidates = [
      known.find((f) => f.key === 'pictures')?.path,
      profile ? `${profile}${pathSep()}Pictures` : undefined,
      oneDrive ? `${oneDrive}${pathSep()}Pictures` : undefined,
    ].filter((p): p is string => !!p);
    this.#drop();
    this.#roots = candidates.filter((p, i) => candidates.findIndex((q) => samePath(q, p)) === i);
    for (const p of this.#roots) void watchPath(p).catch(() => {});
  }

  unwatch() {
    this.#watching++;
    clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#drop();
  }

  #drop() {
    for (const p of this.#roots) void unwatchPath(p).catch(() => {});
    this.#roots = [];
  }

  /** A watched folder changed: if it is one of ours, look again once the burst settles. */
  changed(path: string) {
    if (!this.#roots.some((r) => samePath(r, path))) return;
    clearTimeout(this.#timer);
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      void this.reload();
    }, GALLERY_REFRESH_MS);
  }
}

export const gallery = new GalleryState();

/** The Pictures Gallery as a grid feed. */
export const picturesGallery: GallerySource = {
  label: 'Gallery',
  get groups() {
    return gallery.groups;
  },
  get count() {
    return gallery.items.length;
  },
  get loading() {
    return gallery.loading;
  },
  get error() {
    return gallery.error;
  },
  loadingText: 'Looking through your pictures…',
  emptyText: 'No photos or videos were found under Pictures.',
  reveal: true,
  load: () => {
    void gallery.load();
    void gallery.watch();
  },
  unload: () => gallery.unwatch(),
  reload: () => void gallery.reload(),
};
