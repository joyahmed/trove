// The status bar's reactivity: the selection line on the left (count and size of the selected
// files) and the free space of the drive holding the folder on the right.
import { listing } from '$lib/state/listing.svelte';
import { places } from '$lib/state/places.svelte';
import { recycle } from '$lib/state/recycle.svelte';
import { search } from '$lib/state/search.svelte';
import { selection } from '$lib/state/selection.svelte';
import { tabs } from '$lib/state/tabs.svelte';
import { viewToggles } from '$lib/data/view-toggles';
import type { ViewMode } from '$lib/state/settings.svelte';
import { freeSpaceText, selectionText } from '$lib/utils/status-text';
import { folderSpace } from '$lib/api/transfer';
import type { FolderSpace } from '$lib/types/shell';
import { onWindows } from '$lib/utils/platform';
import { logError } from '$lib/api/log';

export const useStatusBar = () => {
  const inList = $derived(tabs.active.location.kind === 'path' || search.active);
  const location = $derived(tabs.active.location);
  // The OS's answer for the folder itself, so a volume the drive list leaves out (a Mac disk
  // image) shows its own free space. Asked again when the folder changes or the drive list
  // refreshes; an answer for a folder already left is dropped. Windows keeps the drive list.
  let own = $state<{ path: string; space: FolderSpace | null } | null>(null);
  $effect(() => {
    const loc = location;
    void places.drives;
    if (loc.kind !== 'path' || onWindows()) return;
    const path = loc.path;
    folderSpace(path)
      .then((space) => {
        if (tabs.active.location.kind === 'path' && tabs.active.location.path === path) {
          own = { path, space };
        }
      })
      .catch((e: unknown) => logError('statusBar.folderSpace', e));
  });
  return {
    /** the Details / Large icons buttons; which one is on follows the folder's own view */
    get viewButtons() {
      return viewToggles.map((t) => ({ ...t, pressed: tabs.active.view === t.key }));
    },
    /** the buttons show only where a file list does, or a folder's Gallery view stands in for one */
    get showsViewButtons(): boolean {
      return tabs.active.showsList || tabs.active.showsGallery;
    },
    setView(key: ViewMode) {
      tabs.active.setView(key);
    },
    /** "3 of 48 selected · 12 MB" in a folder or a search, "2 of 9 selected" in the Bin; null where the file list is not showing */
    get selectionLine(): string | null {
      // the Bin counts its own selection, not the folder's
      if (location.kind === 'recycle-bin') {
        return recycle.selected.size === 0
          ? null
          : selectionText(recycle.selected, [], recycle.count);
      }
      if (!inList || selection.count === 0) return null;
      return selectionText(selection.paths, listing.rows, listing.rows.length);
    },
    /** "412 GB free on G:" for a folder; '' on a place view or when the free space is unknown */
    get freeSpace(): string {
      if (location.kind !== 'path') return '';
      const space = own?.path === location.path ? own.space : null;
      return freeSpaceText(location.path, places.drives, undefined, space);
    },
  };
};
