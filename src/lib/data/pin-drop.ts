// Pin by dragging a folder onto the sidebar's tail. Unlike `togglePin`, a second drop of the
// same folder leaves it pinned: dropping is "add", never "flip".
import { pathKind } from '$lib/api/fs';
import { knownKeyOf } from '$lib/data/sidebar-sections';
import { settings } from '$lib/state/settings.svelte';
import { samePath } from '$lib/utils/path';

/** Pin each dropped folder; files, missing paths and folders already shown are left alone. */
export const pinDropped = async (paths: string[]) => {
  for (const path of paths) {
    if ((await pathKind(path).catch(() => 'missing' as const)) !== 'dir') continue;
    const known = knownKeyOf(path);
    if (known !== undefined) {
      if (settings.isKnownFolderHidden(known)) settings.toggleKnownFolder(known);
      continue;
    }
    if (!settings.pins.some((p) => samePath(p, path))) settings.pins.push(path);
  }
};
