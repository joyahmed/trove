// The preview pane's reactivity: keeps `preview` pointed at the selection while the pane is
// open, and exposes what the markup renders. Returns getters so the component stays live.
import { untrack } from 'svelte';
import { SvelteSet } from 'svelte/reactivity';
import { previewUrl } from '$lib/api/preview';
import { actions } from '$lib/state/actions.svelte';
import { listing } from '$lib/state/listing.svelte';
import { panes } from '$lib/state/panes.svelte';
import { preview } from '$lib/state/preview.svelte';
import { selection } from '$lib/state/selection.svelte';
import { tabs } from '$lib/state/tabs.svelte';
import type { FileEntry } from '$lib/types/fs';
import { fmtDate, fmtSize } from '$lib/utils/format';
import { locationLabel } from '$lib/utils/location';
import { parentOf } from '$lib/utils/path';
import { tildeHome } from '$lib/utils/path-display';
import { archiveRowFolder, archiveRowWhere } from '$lib/utils/archive-location';
import { previewPlaceIcon } from './use-preview-pane-icon';
import { shortKindOf } from '$lib/utils/short-kind';

export interface PreviewFact {
  label: string;
  value: string;
  /** printed text when it differs from the tooltip `value` (home as `~`) */
  shown?: string;
}

/** The pane's label/value rows from what the listing already knows (no extra stat). */
export const previewFacts = (e: FileEntry, home: string | null = null): PreviewFact[] => {
  const facts: PreviewFact[] = [{ label: 'Type', value: shortKindOf(e) }];
  if (!e.isDir) facts.push({ label: 'Size', value: fmtSize(e.size) });
  if (e.createdMs !== null) facts.push({ label: 'Created', value: fmtDate(e.createdMs) });
  if (e.modifiedMs !== null) facts.push({ label: 'Modified', value: fmtDate(e.modifiedMs) });
  // inside an archive: `a.zip › docs`, as the address bar says it (not the zip's own folder)
  const where = archiveRowWhere(e.path) ?? parentOf(e.path);
  if (where) facts.push({ label: 'Location', value: where, shown: tildeHome(where, home) });
  return facts;
};

/** The mono meta line: kind · size · modified (size and date left out when there are none). */
export const previewMeta = (e: FileEntry): string =>
  [shortKindOf(e), e.isDir ? '' : fmtSize(e.size), fmtDate(e.modifiedMs)]
    .filter(Boolean)
    .join(' · ');

export const usePreviewPane = () => {
  // Reads the rows, the selection and the pane state; everything else is untracked so a text
  // fetch landing does not rerun it.
  $effect(() => {
    const rows = listing.rows;
    // `selection.paths` is a SvelteSet: reading its size and members here tracks them
    const selected: ReadonlySet<string> = new SvelteSet(selection.paths);
    if (!panes.isOpen('preview')) return;
    untrack(() => preview.sync(rows, selected));
  });

  // `preview.source`: the file's own path, or the temp copy of a file inside an archive
  // `?v=`: the protocol reads the path only; a new size or mtime makes a new URL, so an image or
  // video whose file changed under the same path (Replace, its Undo) is loaded again, not reused.
  const url = $derived(
    preview.source && preview.entry
      ? `${previewUrl(preview.source)}?v=${preview.entry.modifiedMs ?? 0}-${preview.entry.size}`
      : '',
  );
  const folderLabel = $derived(locationLabel(tabs.active.location));
  // a place (Home, This PC, Trash, Gallery) has no file list to count: no "0 items" there
  const folderCount = $derived(tabs.active.isFolder ? listing.rows.length : null);

  return {
    get entry() {
      return preview.entry;
    },
    get kind() {
      return preview.kind;
    },
    get count() {
      return preview.count;
    },
    get text() {
      return preview.text;
    },
    get loading() {
      return preview.loading;
    },
    get error() {
      return preview.error;
    },
    /** A sentence in place of the preview (a file inside an archive that is not shown). */
    get notice() {
      return preview.notice;
    },
    get url() {
      return url;
    },
    get folderLabel() {
      return folderLabel;
    },
    get placeIcon() {
      return previewPlaceIcon(tabs.active.location);
    },
    get folderCount() {
      return folderCount;
    },
    close: () => panes.close(),
    /** "Open": the default app. There is no Open-with command in Trove yet, so no twin button. */
    open: (entry: FileEntry) => void actions.open(entry),
    /** "Reveal": navigate the tab to the file's folder and select it there (as Gallery does). */
    reveal: async (entry: FileEntry) => {
      // inside an archive: its inner folder, never a real path cut out of the row's
      const parent = archiveRowFolder(entry.path) ?? parentOf(entry.path);
      if (!parent) return;
      await tabs.active.navigate(parent);
      selection.reveal(entry.path);
    },
  };
};
