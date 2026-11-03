// What "New" can make, as Explorer lists it: a folder first, then file kinds. Each file kind is
// an empty file with Explorer's default name; Shortcut (.lnk) needs the shell and is out.
import type { GlyphName } from '$lib/data/glyphs';

export interface NewItemKind {
  key: string;
  label: string;
  glyph: GlyphName;
  /** '' for the folder; otherwise the extension without the dot */
  ext: string;
  /** the name before the extension, before "(2)" numbering */
  baseName: string;
}

export const newItemKinds: NewItemKind[] = [
  { key: 'folder', label: 'Folder', glyph: 'folder', ext: '', baseName: 'New folder' },
  { key: 'text', label: 'Text Document', glyph: 'file', ext: 'txt', baseName: 'New Text Document' },
  {
    key: 'markdown',
    label: 'Markdown Document',
    glyph: 'file',
    ext: 'md',
    baseName: 'New Document',
  },
];
