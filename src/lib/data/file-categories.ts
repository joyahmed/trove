// Which drawn icon a FILE gets off Windows, where the shell has no icon to give (plan 14).
// Windows never reads this: it keeps the shell's real per-file icons (`utils/file-icon.ts`).
//
// ⚠️ Not `preview-kinds.ts`, and must not be coupled to it: that map answers what the preview
// pane can render, this one answers what a file looks like in a list.
// ⛔ Computed from the NAME, not `entry.ext`: Rust's `Path::extension` gives `null` for
// `.gitignore` / `.env` and `gz` for `a.tar.gz` (`fs.rs`), which would make every dotfile generic.
import type { GlyphName } from './glyphs';

export const fileCategories = [
  'file',
  'text',
  'document',
  'pdf',
  'spreadsheet',
  'presentation',
  'image',
  'video',
  'audio',
  'archive',
  'diskImage',
  'code',
  'script',
  'config',
  'app',
  'font',
  'database',
  'cert',
] as const;

export type FileCategory = (typeof fileCategories)[number];

/** Each category's drawing and tint. The tint is a CSS variable with a light and a dark value
 * (`app.css`, `--color-ftype-*`); mono categories use the secondary text colour. */
export const fileCategoryIcons: Record<FileCategory, { glyph: GlyphName; tint: string }> = {
  file: { glyph: 'file', tint: 'var(--color-text-secondary)' },
  text: { glyph: 'fileText', tint: 'var(--color-text-secondary)' },
  document: { glyph: 'fileDocument', tint: 'var(--color-ftype-document)' },
  // ⚠️ shares the text drawing; told apart by tint and the Type column (plan 14 traps)
  pdf: { glyph: 'fileText', tint: 'var(--color-ftype-pdf)' },
  spreadsheet: { glyph: 'fileSpreadsheet', tint: 'var(--color-ftype-spreadsheet)' },
  presentation: { glyph: 'filePresentation', tint: 'var(--color-ftype-presentation)' },
  image: { glyph: 'fileImage', tint: 'var(--color-ftype-image)' },
  video: { glyph: 'fileVideo', tint: 'var(--color-ftype-video)' },
  audio: { glyph: 'fileAudio', tint: 'var(--color-ftype-audio)' },
  archive: { glyph: 'fileArchive', tint: 'var(--color-ftype-archive)' },
  diskImage: { glyph: 'fileDiskImage', tint: 'var(--color-text-secondary)' },
  code: { glyph: 'fileCode', tint: 'var(--color-ftype-code)' },
  script: { glyph: 'fileScript', tint: 'var(--color-ftype-code)' },
  config: { glyph: 'fileConfig', tint: 'var(--color-text-secondary)' },
  app: { glyph: 'fileApp', tint: 'var(--color-text-secondary)' },
  font: { glyph: 'fileFont', tint: 'var(--color-text-secondary)' },
  database: { glyph: 'fileDatabase', tint: 'var(--color-text-secondary)' },
  cert: { glyph: 'fileCert', tint: 'var(--color-text-secondary)' },
};

export const fileCategoryExtensions: Record<Exclude<FileCategory, 'file'>, readonly string[]> = {
  text: ['txt', 'md', 'markdown', 'log', 'rst', 'nfo', 'text'],
  document: ['doc', 'docx', 'odt', 'rtf', 'pages', 'wpd', 'epub', 'tex'],
  pdf: ['pdf'],
  spreadsheet: ['xls', 'xlsx', 'xlsm', 'ods', 'csv', 'tsv', 'numbers'],
  // ⛔ `.key` is Keynote on a Mac, not a private key
  presentation: ['ppt', 'pptx', 'odp', 'key'],
  image: [
    'png',
    'jpg',
    'jpeg',
    'gif',
    'webp',
    'svg',
    'heic',
    'heif',
    'avif',
    'bmp',
    'tif',
    'tiff',
    'ico',
    'icns',
    'psd',
    'raw',
    'cr2',
    'nef',
    'arw',
    'dng',
  ],
  video: [
    'mp4',
    'mkv',
    'mov',
    'avi',
    'webm',
    'm4v',
    'wmv',
    'flv',
    'mpg',
    'mpeg',
    '3gp',
    'ogv',
    'mts',
    'm2ts',
  ],
  audio: [
    'mp3',
    'flac',
    'wav',
    'm4a',
    'ogg',
    'oga',
    'aac',
    'wma',
    'aif',
    'aiff',
    'opus',
    'mid',
    'midi',
  ],
  archive: [
    'zip',
    'tar',
    'gz',
    'tgz',
    'bz2',
    'tbz2',
    'xz',
    'txz',
    'zst',
    'tzst',
    '7z',
    'rar',
    'lz',
    'lzma',
    'cab',
    'tar.gz',
    'tar.bz2',
    'tar.xz',
    'tar.zst',
  ],
  diskImage: ['dmg', 'iso', 'img', 'vhd', 'vhdx', 'vmdk', 'qcow2', 'toast'],
  code: [
    'ts',
    'tsx',
    // not 'mts': that is an AVCHD camera video (in `video`), and the camera file is the common one here
    'cts',
    'js',
    'jsx',
    'mjs',
    'cjs',
    'json',
    'jsonc',
    'rs',
    'py',
    'go',
    'c',
    'h',
    'cpp',
    'cc',
    'hpp',
    'cs',
    'java',
    'kt',
    'kts',
    'swift',
    'rb',
    'php',
    'lua',
    'dart',
    'scala',
    'zig',
    'ex',
    'exs',
    'hs',
    'html',
    'htm',
    'css',
    'scss',
    'sass',
    'less',
    'svelte',
    'vue',
    'sql',
    'xml',
    'graphql',
    'proto',
    'ipynb',
  ],
  script: ['sh', 'bash', 'zsh', 'fish', 'ps1', 'psm1', 'bat', 'cmd', 'command'],
  config: [
    'yaml',
    'yml',
    'toml',
    'ini',
    'conf',
    'cfg',
    'env',
    'properties',
    'plist',
    'lock',
    'editorconfig',
    'gitignore',
    'gitattributes',
    'gitmodules',
    'dockerignore',
    'npmrc',
    'nvmrc',
    'prettierrc',
    'prettierignore',
    'eslintrc',
    'bashrc',
    'zshrc',
    'profile',
  ],
  app: [
    'exe',
    'msi',
    'msix',
    'appx',
    'app',
    'deb',
    'rpm',
    'appimage',
    'apk',
    // an iOS app package (the Mac run found it falling back to a blank document)
    'ipa',
    'pkg',
    'snap',
    'flatpak',
    'jar',
  ],
  font: ['ttf', 'otf', 'woff', 'woff2', 'eot', 'ttc'],
  database: ['db', 'sqlite', 'sqlite3', 'mdb', 'accdb'],
  cert: ['pem', 'crt', 'cer', 'der', 'p12', 'pfx', 'csr', 'pub', 'gpg', 'asc'],
};

/** Names with no extension that still say what they are. Lower-case. */
const BARE_NAMES: Readonly<Record<string, FileCategory>> = {
  readme: 'text',
  license: 'text',
  licence: 'text',
  changelog: 'text',
  authors: 'text',
  copying: 'text',
  makefile: 'code',
  dockerfile: 'code',
  gemfile: 'code',
  rakefile: 'code',
  justfile: 'code',
  procfile: 'config',
};

const BY_EXTENSION: ReadonlyMap<string, FileCategory> = new Map(
  (Object.entries(fileCategoryExtensions) as [FileCategory, readonly string[]][]).flatMap(
    ([cat, exts]) => exts.map((e) => [e, cat] as const),
  ),
);

/**
 * `photo.JPG` → `image`; `a.tar.gz` → `archive`; `.env.local` → `config`; `Makefile` → `code`;
 * anything unknown → `file`. Lookup order: a known compound (`tar.gz`), the last extension, a
 * dotfile's first segment, an extension-less name.
 */
export const fileCategoryOf = (name: string): FileCategory => {
  const lower = name.toLowerCase();
  const dotfile = lower.startsWith('.');
  const parts = (dotfile ? lower.slice(1) : lower).split('.');
  if (parts.length >= 3 || (dotfile && parts.length >= 2)) {
    const compound = BY_EXTENSION.get(parts.slice(-2).join('.'));
    if (compound) return compound;
  }
  if (parts.length >= 2 || dotfile) {
    const last = BY_EXTENSION.get(parts[parts.length - 1]);
    if (last) return last;
  }
  if (dotfile) {
    const first = BY_EXTENSION.get(parts[0]);
    if (first) return first;
  }
  if (parts.length === 1 && !dotfile) return BARE_NAMES[parts[0]] ?? 'file';
  return 'file';
};

/** The drawing and tint for a file's name. */
export const fileTypeIconOf = (name: string) => fileCategoryIcons[fileCategoryOf(name)];
