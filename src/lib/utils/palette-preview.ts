// The palette's preview pane (plan 04 4.4), the parts that are pure: which key shows or hides it,
// which rows it can show, and the copy-path choices for a row. The reactivity is in
// hooks/use-palette-preview.svelte.ts; the markup in palette-parts/PalettePreview.svelte.
import type { PaletteResult } from '$lib/types/palette';
import { toLinuxForm } from '$lib/utils/path';

type Chord = Pick<KeyboardEvent, 'key' | 'altKey' | 'ctrlKey' | 'metaKey' | 'shiftKey'>;

/**
 * Alt+→ shows the pane, Alt+← hides it (⌥→ / ⌥← on a Mac); anything else is not ours. Plain
 * Alt only: Ctrl+Alt is AltGr on a PC, and Shift+Alt+arrow selects by word in the input.
 */
export const previewToggle = (e: Chord): 'show' | 'hide' | null => {
  if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return null;
  if (e.key === 'ArrowRight') return 'show';
  if (e.key === 'ArrowLeft') return 'hide';
  return null;
};

/** The narrowest the result list may get beside the pane: a row's name and path still read. */
export const PALETTE_LIST_MIN = 280;

/**
 * The pane fits beside the list in `available` px: the list keeps `PALETTE_LIST_MIN`. Below that
 * the pane hides (still switched on, back when there is room) rather than squeeze the list -
 * an 800 px window at a large text size is a ~400 px page (panes.ts `previewFits` does the same).
 */
export const palettePreviewFits = (available: number, previewWidth: number): boolean =>
  available - previewWidth >= PALETTE_LIST_MIN;

/** The row is a file or folder on disk: the pane has something to show for it. */
export const isPreviewable = (
  r: PaletteResult | undefined,
): r is PaletteResult & {
  previewPath: string;
} => typeof r?.previewPath === 'string' && r.previewPath !== '';

export interface CopyPathForm {
  key: 'path' | 'linux';
  label: string;
  text: string;
}

/**
 * What Copy path offers for `path`: the path as Windows (or the host) writes it, and for a file
 * on a WSL share also its `distro:/…` form — the two `actions.copyAsPath` chooses between in the
 * explorer, offered side by side here because the palette has no selection to decide by.
 */
export const copyPathForms = (path: string): CopyPathForm[] => {
  const forms: CopyPathForm[] = [{ key: 'path', label: 'Copy path', text: path }];
  const linux = toLinuxForm(path);
  if (linux !== null) forms.push({ key: 'linux', label: 'Copy Linux path', text: linux });
  return forms;
};

/** Why the rename box cannot send `draft`, or null when it can (the backend checks the rest). */
export const renameProblem = (draft: string): string | null => {
  const name = draft.trim();
  if (name === '') return 'Type a name.';
  if (/[\\/]/.test(name)) return 'A name cannot contain \\ or /.';
  return null;
};

/** The folder summary line: "12 items" / "1 item"; null while the count is not in yet. */
export const folderCountLabel = (count: number | null): string | null =>
  count === null ? null : `${count} ${count === 1 ? 'item' : 'items'}`;
