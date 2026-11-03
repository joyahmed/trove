// The sidebar is these sections rendered once. Items with a `location` navigate (or `run`
// when the click needs more than a navigate); a node with `children` expands on its chevron.
// Network is not listed until UNC browsing exists (Phase 5) — mapped drives already show as
// drive letters under Drives, whose header opens This PC.
import { binName, onWindows } from '$lib/utils/platform';
import { isWslPath, samePath } from '$lib/utils/path';
import type { GlyphName } from '$lib/data/glyphs';
import { folderIcon, knownFolderIcons } from '$lib/data/known-folder-icons';
import { PLACE_ICONS } from '$lib/data/place-icons';
import { fmtSpace } from '$lib/utils/format';
import { places } from '$lib/state/places.svelte';
import { settings, type SidebarKey } from '$lib/state/settings.svelte';
import { wsl } from '$lib/state/wsl.svelte';
import type { Location } from '$lib/types/location';
import type { KnownFolderKey } from '$lib/types/shell';
import {
  APPLICATIONS,
  GALLERY,
  HOME,
  RECYCLE_BIN,
  THIS_PC,
  locationLabel,
  pathLocation,
} from '$lib/utils/location';

export interface SidebarItem {
  key: string;
  label: string;
  glyph: GlyphName;
  /** CSS colour for the glyph; Explorer's sidebar icons are coloured */
  color: string;
  /** where the item points; the active highlight follows it */
  location?: Location;
  /** what a click does when it is more than `navigate(location)` */
  run?: () => unknown;
  pinned?: boolean;
  /** a small muted word after the label (`WSL` on a pinned WSL folder) */
  tag?: string;
  /** set on a built-in Quick access folder, so Unpin can hide it rather than edit `pins` */
  knownKey?: KnownFolderKey;
  /** a drive's fill (0..1), its "N GB free of M GB" and how full it reads; absent when the OS
   * would not say */
  usage?: DriveUsage;
  /** shows a chevron; with `children` it expands, without (OneDrive unset) it is decoration */
  expandable?: boolean;
  /** items shown indented below when the node is expanded */
  children?: () => SidebarItem[];
}

/** How full a drive reads: a neutral bar, amber when it is getting tight, red when it is full. */
export type UsageLevel = 'ok' | 'low' | 'critical';

export interface DriveUsage {
  fraction: number;
  caption: string;
  level: UsageLevel;
}

export interface SidebarSection {
  key: string;
  /** a collapsible header row (Explorer's "Quick access"); headerless sections just list */
  title?: string;
  /** where the header's label goes; the chevron still folds */
  location?: Location;
  /** drawn (header and all) with no rows; otherwise an empty section is skipped */
  keepWhenEmpty?: boolean;
  items: () => SidebarItem[];
}

/** Section keys that persist as folded in `settings.sidebarCollapsed`. */
export const QUICK_ACCESS_KEY = 'quick-access';
export const DRIVES_KEY = 'drives';

export const isExpanded = (key: string) => !settings.isCollapsed(key);

/** The built-in folder a path is, if any — so pinning Downloads again un-hides Downloads. */
export const knownKeyOf = (path: string): KnownFolderKey | undefined =>
  places.knownFolders.find((f) => samePath(f.path, path))?.key;

/** The built-in Quick access folders the person has not unpinned. */
export const visibleKnownFolders = () =>
  places.knownFolders.filter((f) => !settings.isKnownFolderHidden(f.key));

/** Home, Gallery, OneDrive and the Bin, minus the ones the person unpinned. */
const shown = (items: SidebarItem[]) =>
  items.filter((i) => !settings.isSidebarKeyHidden(i.key as SidebarKey));

const driveItems = (): SidebarItem[] =>
  places.drives.map((d) => ({
    key: d.path,
    ...driveName(d.label, d.path),
    glyph: 'drive' as GlyphName,
    color: '#9aa4b2',
    location: pathLocation(d.path),
    usage: driveUsage(d.totalBytes, d.freeBytes),
  }));

/** Red at 90% used is the same line as the Places drive tiles (place-tiles.ts) and Explorer's own
 * This PC bar, so one drive never reads full in one place and fine in the other. Amber at 80% is
 * the early warning the sidebar adds: the bar stays neutral until it has something to say. */
const LOW_USED = 0.8;
const CRITICAL_USED = 0.9;

const usageLevel = (used: number): UsageLevel =>
  used >= CRITICAL_USED ? 'critical' : used >= LOW_USED ? 'low' : 'ok';

/** ⛔ Unknown is not zero: a failed size query gives no usage at all, never an empty bar. */
export const driveUsage = (total: number | null, free: number | null): DriveUsage | undefined => {
  if (total == null || free == null || total <= 0) return undefined;
  const fraction = Math.min(1, Math.max(0, (total - free) / total));
  return {
    fraction,
    caption: `${fmtSpace(free)} free of ${fmtSpace(total)}`,
    level: usageLevel(fraction),
  };
};

/** A Windows drive is its volume name with the letter as a muted tag (`System` … `C:`), so a long
 * name truncates and the letter never does. Elsewhere the volume's own name stands alone, because
 * the first two characters of `/media/DATADRIVE` are not a drive letter (they read `/m`). An
 * unnamed Windows volume is its letter alone, never an empty label. */
export const driveName = (label: string, path: string): { label: string; tag?: string } => {
  if (!/^[A-Za-z]:[\\/]?$/.test(path)) return { label };
  const letter = path.slice(0, 2).toUpperCase();
  return label.trim() ? { label, tag: letter } : { label: letter };
};

/** A pinned folder's row text: a drive or volume root reads as the Drives row does (`Macintosh HD`,
 * `OS` + `C:`), not as `/`; any other path is its last segment; never empty. */
export const pinName = (path: string): { label: string; tag?: string } => {
  const drive = places.drives.find((d) => samePath(d.path, path));
  if (drive) {
    const name = driveName(drive.label, drive.path);
    if (name.label.trim()) return name;
  }
  return { label: locationLabel(pathLocation(path)).trim() || path };
};

/** OneDrive is a Windows concept: its row is hidden off Windows unless a root really is found. */
export const oneDriveRows = (root: string | null, windows: boolean): SidebarItem[] => {
  if (root) return [oneDriveItem(root)];
  return windows ? [oneDriveItem(null)] : [];
};

const oneDriveItem = (root: string | null): SidebarItem => {
  return root
    ? {
        key: 'onedrive',
        label: 'OneDrive',
        glyph: 'cloud',
        color: '#0f6cbd',
        location: pathLocation(root),
      }
    : { key: 'onedrive', label: 'OneDrive', glyph: 'cloud', color: '#0f6cbd', expandable: true };
};

export const sidebarSections: SidebarSection[] = [
  {
    key: QUICK_ACCESS_KEY,
    title: 'Pinned',
    // the drop tail lives here, so the header stays with nothing pinned
    keepWhenEmpty: true,
    items: () => [
      // Home is the first pinned row: unpinning hides it (hiddenSidebarKeys), restore brings it back
      ...shown([
        {
          key: 'home',
          label: 'Home',
          ...PLACE_ICONS.home,
          location: HOME,
          pinned: true,
        },
      ]),
      ...visibleKnownFolders().map((f) => ({
        key: f.key,
        label: f.label,
        location: pathLocation(f.path),
        pinned: true,
        knownKey: f.key,
        ...knownFolderIcons[f.key],
      })),
      ...settings.pins
        .filter((path) => path !== '')
        .map((path) => {
          const name = pinName(path);
          return {
            key: `pin:${path}`,
            label: name.label,
            location: pathLocation(path),
            pinned: true,
            tag: isWslPath(path) ? 'WSL' : name.tag,
            ...folderIcon,
          };
        }),
    ],
  },
  {
    key: DRIVES_KEY,
    // the rows are the drives; the header's label opens This PC (its per-OS name is the tooltip)
    title: 'Drives',
    location: THIS_PC,
    items: driveItems,
  },
  {
    key: 'system',
    items: () =>
      shown([
        // no top block any more: Gallery and OneDrive sit with the Bin, in one headerless group
        { key: 'gallery', label: 'Gallery', ...PLACE_ICONS.gallery, location: GALLERY },
        {
          key: 'applications',
          label: 'Applications',
          ...PLACE_ICONS.applications,
          location: APPLICATIONS,
        },
        ...oneDriveRows(places.oneDriveRoot, onWindows()),
        {
          key: 'recycle-bin',
          label: binName(),
          ...PLACE_ICONS['recycle-bin'],
          location: RECYCLE_BIN,
        },
      ]),
  },
  {
    // every installed distro, as Explorer's Linux node lists them; a click lands on its home
    key: 'linux',
    title: 'Linux',
    items: () =>
      wsl.distros.map((d) => ({
        key: `wsl:${d.name}`,
        label: d.name,
        glyph: 'linux' as GlyphName,
        color: '#f5b400',
        location: pathLocation(`\\\\wsl.localhost\\${d.name}\\`),
        run: () => wsl.open(d),
      })),
  },
];
