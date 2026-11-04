// The name a row, tile or card SHOWS, under the "File name extensions" setting. The rules are
// `utils/file-name` (pure); this only reads the setting, so markup can call it bare.
import type { FileEntry } from '$lib/types/fs';
import { settings } from '$lib/state/settings.svelte';
import { nameLabel } from '$lib/utils/file-name';

export const displayName = (entry: Pick<FileEntry, 'isDir' | 'name'>): string =>
  nameLabel(entry, settings.showExtensions);
