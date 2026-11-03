// The right-click menu on a Home / This PC tile: the sidebar's own place menu (Open in new tab,
// Open in new window, Pin / Unpin, Open in Terminal), never a menu of its own. A folder or drive
// tile is turned into the sidebar row it would be, then `sidebarMenuFor` builds the items, so the
// two menus cannot drift apart. ⛔ A recent FILE tile gets none: the sidebar has no file rows, and
// "Open in new tab" on a file path would open a folder that is not one.
import type { MenuItem } from '$lib/hooks/use-menu.svelte';
import type { PlaceTile } from '$lib/data/place-tiles';
import { sidebarMenuFor, type SidebarMenuHandlers } from '$lib/data/sidebar-menu';
import { knownKeyOf, type SidebarItem } from '$lib/data/sidebar-sections';
import { settings } from '$lib/state/settings.svelte';
import { pathLocation } from '$lib/utils/location';

/** The sidebar row a tile stands for, or `null` for a file tile. */
export const tileAsSidebarItem = (tile: PlaceTile): SidebarItem | null => {
  if (tile.kind === 'file') return null;
  const known = knownKeyOf(tile.path);
  return {
    key: tile.key,
    label: tile.label,
    ...(tile.kind === 'drive'
      ? { glyph: 'drive' as const, color: '#9aa4b2' }
      : { glyph: tile.glyph, color: tile.color }),
    location: pathLocation(tile.path),
    // a built-in folder is pinned while it is shown in the sidebar; a hidden one offers Pin again
    // (This PC lists it even when unpinned), which `togglePin` turns back into "show it"
    knownKey: known !== undefined && !settings.isKnownFolderHidden(known) ? known : undefined,
  };
};

export const placeTileMenuFor = (tile: PlaceTile, on: SidebarMenuHandlers): MenuItem[] => {
  const item = tileAsSidebarItem(tile);
  return item ? sidebarMenuFor(item, on) : [];
};
