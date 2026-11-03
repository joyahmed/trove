// The status bar's two view buttons, as Explorer has them: details and large icons.
import type { GlyphName } from '$lib/data/glyphs';
import type { ViewMode } from '$lib/state/settings.svelte';

export interface ViewToggle {
  key: ViewMode;
  glyph: GlyphName;
  label: string;
}

export const viewToggles: ViewToggle[] = [
  { key: 'details', glyph: 'viewDetails', label: 'Details view' },
  { key: 'grid', glyph: 'viewTiles', label: 'Large icons view' },
];
