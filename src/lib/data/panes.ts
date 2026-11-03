// The right-side panes, by kind, as lazy module loaders (they mount on a click, never at first
// paint — CONTRIBUTING § 5). The host renders whichever `panes.open` names.
import type { Component } from 'svelte';
import { LIST_MIN_WIDTH, type PaneKind } from '$lib/state/panes.svelte';

export const paneModules: Record<PaneKind, () => Promise<{ default: Component }>> = {
  details: () => import('$lib/components/panes/DetailsPane.svelte'),
  preview: () => import('$lib/components/panes/PreviewPane.svelte'),
};

/** The narrowest the Preview pane is worth showing (its preview, buttons and facts need this). */
export const PREVIEW_MIN_WIDTH = 240;

/**
 * Whether the Preview pane may show: the file list keeps `LIST_MIN_WIDTH` and the pane gets at
 * least `PREVIEW_MIN_WIDTH`. Below that the pane hides (it stays "open", and returns when the
 * window grows) rather than squeeze the list.
 */
export const previewFits = (viewportWidth: number, sidebarWidth: number): boolean =>
  viewportWidth - sidebarWidth - LIST_MIN_WIDTH >= PREVIEW_MIN_WIDTH;
