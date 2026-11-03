// The "text size" entries of the … menu: the whole UI zooms, as a browser does, remembered in
// settings.zoom. The chords live in data/shortcuts.ts and do the same.
import type { MenuItem } from '$lib/hooks/use-menu.svelte';
import { settings, ZOOM } from '$lib/state/settings.svelte';
import { keyLabel } from '$lib/utils/key-label';

export const zoomItems: MenuItem[] = [
  {
    kind: 'item',
    key: 'zoom-in',
    label: 'Text bigger',
    shortcut: keyLabel('Ctrl++'),
    enabled: () => settings.zoom < ZOOM.max,
    run: () => settings.zoomBy(1),
  },
  {
    kind: 'item',
    key: 'zoom-out',
    label: 'Text smaller',
    shortcut: keyLabel('Ctrl+-'),
    enabled: () => settings.zoom > ZOOM.min,
    run: () => settings.zoomBy(-1),
  },
  {
    kind: 'item',
    key: 'zoom-reset',
    label: 'Reset text size',
    shortcut: keyLabel('Ctrl+0'),
    enabled: () => settings.zoom !== 1,
    run: () => (settings.zoom = 1),
  },
];
