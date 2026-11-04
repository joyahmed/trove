// The ▾ list a breadcrumb's chevron opens (plan 06 § 6.4): the subfolders of the crumb to the
// left of the chevron, as Explorer's address-bar chevrons list them. Pure: the hook reads the
// folder, this turns the listing into menu rows.
import type { MenuItem } from '$lib/hooks/use-menu.svelte';
import type { FileEntry } from '$lib/types/fs';
import { samePath } from '$lib/utils/path';

const names = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });

/** What the list shows for a folder with no subfolders, or one that could not be read. */
export const NO_SUBFOLDERS: MenuItem = {
  kind: 'item',
  key: 'none',
  label: 'No subfolders',
  enabled: () => false,
  run: () => undefined,
};

/**
 * The subfolders of a listing, by name (digits as numbers); hidden ones only when shown — except
 * `current`, the folder the path continues into, which is always listed: standing inside
 * `~/x/.hid` with hidden files off, the `x` chevron said "No subfolders" about the folder you
 * were in.
 */
export const subfoldersOf = (
  entries: readonly FileEntry[],
  showHidden: boolean,
  current: string | null = null,
): FileEntry[] =>
  entries
    .filter(
      (e) =>
        e.isDir && (showHidden || !e.isHidden || (current !== null && samePath(e.path, current))),
    )
    .sort((a, b) => names.compare(a.name, b.name));

/**
 * Menu rows for those subfolders. The one the path continues into (`current`, the next crumb) is
 * checked, so the list shows where you are. Picking a row calls `go` with that folder's path.
 */
export const crumbMenuItems = (
  entries: readonly FileEntry[],
  opts: { showHidden: boolean; current: string | null; go: (path: string) => unknown },
): MenuItem[] => {
  const rows: MenuItem[] = subfoldersOf(entries, opts.showHidden, opts.current).map((e) => ({
    kind: 'item',
    key: e.path,
    label: e.name,
    glyph: 'folder',
    checked: opts.current !== null && samePath(e.path, opts.current) ? () => true : undefined,
    run: () => opts.go(e.path),
  }));
  return rows.length ? rows : [NO_SUBFOLDERS];
};
