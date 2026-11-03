// Each place's own icon — the glyph and colour the sidebar row draws — in one table, so the tab
// strip and the sidebar never disagree. ⛔ The tab used to draw the yellow folder on every tab,
// so the Trash, This PC and Home tabs looked like folders (the Mac, 2026-10-08).
import type { GlyphName } from '$lib/data/glyphs';
import type { Location, PlaceKind } from '$lib/types/location';

export interface PlaceIcon {
  glyph: GlyphName;
  /** CSS colour for the glyph; Explorer's sidebar icons are coloured */
  color: string;
}

export const PLACE_ICONS: Record<PlaceKind, PlaceIcon> = {
  home: { glyph: 'home', color: '#e8a33d' },
  // the Drives header opens This PC and has no row icon: the palette's "Open This PC" glyph, in
  // the drive rows' colour
  'this-pc': { glyph: 'thisPc', color: '#9aa4b2' },
  gallery: { glyph: 'gallery', color: '#4cc2ff' },
  applications: { glyph: 'fileApp', color: '#7a7fe0' },
  'recycle-bin': { glyph: 'delete', color: '#9aa4b2' },
};

/** The place's icon for a tab on a place; `null` on a folder or an archive (the yellow folder). */
export const placeIconFor = (location: Location): PlaceIcon | null =>
  location.kind === 'path' || location.kind === 'archive' ? null : PLACE_ICONS[location.kind];
