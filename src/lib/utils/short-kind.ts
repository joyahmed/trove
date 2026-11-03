// The Type column's short kind: "Spreadsheet", not "Microsoft Excel Comma Separated Values File".
// Same on every OS; the shell's `typeName` stays on the entry for the details pane.
import { fileCategoryOf, type FileCategory } from '$lib/data/file-categories';
import type { FileEntry } from '$lib/types/fs';
import { isAppBundle } from './app-bundle';

export const shortKindLabels: Record<Exclude<FileCategory, 'file'>, string> = {
  text: 'Text',
  document: 'Document',
  pdf: 'PDF',
  spreadsheet: 'Spreadsheet',
  presentation: 'Presentation',
  image: 'Image',
  video: 'Video',
  audio: 'Audio',
  archive: 'Archive',
  diskImage: 'Disk image',
  code: 'Code',
  script: 'Script',
  config: 'Config',
  app: 'App',
  font: 'Font',
  database: 'Database',
  cert: 'Certificate',
};

/** Folder for a directory (App for a Mac's `X.app` bundle); the category's label for a known
 *  file; otherwise "BIN file" from the extension, or plain "File" when there is none. */
export const shortKindOf = (
  e: Pick<FileEntry, 'name' | 'isDir' | 'ext'> & Partial<Pick<FileEntry, 'isLink' | 'typeName'>>,
  platform?: Parameters<typeof isAppBundle>[1],
): string => {
  if (e.isDir) return isAppBundle(e, platform) ? 'App' : 'Folder';
  // a macOS Finder alias (Rust names it "Alias"): its name is "X alias" or "x.jpg alias", which
  // has no real extension, so it must not read "File" or "JPG ALIAS file"
  if (e.isLink && e.typeName === 'Alias') return 'Alias';
  // "x.jpg alias" → Rust's extension "jpg alias": a space means it is not an extension
  if (e.ext?.includes(' ')) return 'File';
  const cat = fileCategoryOf(e.name);
  if (cat !== 'file') return shortKindLabels[cat];
  return e.ext ? `${e.ext.toUpperCase()} file` : 'File';
};
