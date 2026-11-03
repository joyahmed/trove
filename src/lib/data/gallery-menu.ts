// The Gallery thumbnail's right-click menu, as data, built for one item. The handlers come in
// from the hook so this stays data.
import type { MenuItem } from '$lib/hooks/use-menu.svelte';
import type { FileEntry } from '$lib/types/fs';
import { commandHint } from '$lib/utils/key-label';

export interface GalleryMenuHandlers {
  open: (entry: FileEntry) => unknown;
  /** left out in a folder's own Gallery view: the item is already in its location */
  reveal?: (entry: FileEntry) => unknown;
}

export const galleryMenuFor = (entry: FileEntry, on: GalleryMenuHandlers): MenuItem[] => [
  {
    kind: 'item',
    key: 'open',
    label: 'Open',
    shortcut: commandHint('galleryOpen'),
    run: () => on.open(entry),
  },
  ...(on.reveal
    ? [
        {
          kind: 'item',
          key: 'reveal',
          label: 'Open file location',
          glyph: 'folder',
          run: () => on.reveal?.(entry),
        } satisfies MenuItem,
      ]
    : []),
];
