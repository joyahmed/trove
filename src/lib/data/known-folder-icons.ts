// The coloured Fluent glyph for each known folder — shared by the sidebar and the place tiles,
// so Desktop looks the same everywhere it appears.
import type { GlyphName } from '$lib/data/glyphs';
import type { KnownFolderKey } from '$lib/types/shell';

export interface FolderGlyph {
  glyph: GlyphName;
  /** CSS colour for the glyph; Explorer's folder icons are coloured */
  color: string;
}

export const knownFolderIcons: Record<KnownFolderKey, FolderGlyph> = {
  desktop: { glyph: 'desktop', color: '#4cc2ff' },
  downloads: { glyph: 'downloads', color: '#3fb950' },
  documents: { glyph: 'documents', color: '#9aa4b2' },
  pictures: { glyph: 'pictures', color: '#4cc2ff' },
  music: { glyph: 'music', color: '#ff7eb6' },
  videos: { glyph: 'videos', color: '#c084fc' },
};

/** A plain or pinned folder: Explorer's yellow folder glyph. */
export const folderIcon: FolderGlyph = { glyph: 'folder', color: 'var(--color-folder)' };
