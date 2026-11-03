// The palette's groups in display order; the order is also the ranking tie-break.
import type { GlyphName } from '$lib/data/glyphs';
import type { PaletteCategory } from '$lib/types/palette';

export interface PaletteCategoryInfo {
  key: PaletteCategory;
  label: string;
  glyph: GlyphName;
}

export const paletteCategories: PaletteCategoryInfo[] = [
  // first, so an answer wins the ranker's category tie-break and sits above every other group
  { key: 'calc', label: 'Calculator', glyph: 'calculator' },
  { key: 'actions', label: 'Actions', glyph: 'more' },
  { key: 'path', label: 'Path', glyph: 'folder' },
  { key: 'recent', label: 'Recent', glyph: 'refresh' },
  { key: 'places', label: 'Places', glyph: 'thisPc' },
  { key: 'apps', label: 'Apps', glyph: 'view' },
  { key: 'files', label: 'Files', glyph: 'file' },
  // last, so the web row renders under Files — it is the fallback when nothing local fit
  { key: 'web', label: 'Web', glyph: 'search' },
];

export const categoryOrder = (key: PaletteCategory) =>
  paletteCategories.findIndex((c) => c.key === key);
