import { describe, expect, it } from 'vitest';
import { glyphIcons } from './glyph-icons';
import { glyphNames } from './glyphs';
import {
  fileCategories,
  fileCategoryExtensions,
  fileCategoryIcons,
  fileCategoryOf,
  type FileCategory,
} from './file-categories';

/** Every extension the Mac run and the brief named, by the category it must land in. */
const EXPECTED: Record<FileCategory, string[]> = {
  image: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'heic'],
  video: ['mp4', 'mkv', 'mov', 'avi', 'webm'],
  audio: ['mp3', 'flac', 'wav', 'm4a', 'ogg'],
  archive: ['zip', 'tar', 'gz', '7z', 'rar'],
  diskImage: ['dmg', 'iso'],
  pdf: ['pdf'],
  document: ['doc', 'docx', 'pages'],
  spreadsheet: ['xls', 'xlsx', 'csv', 'numbers'],
  presentation: ['ppt', 'pptx', 'key'],
  text: ['md', 'txt', 'log'],
  code: ['ts', 'tsx', 'js', 'jsx', 'json', 'rs', 'py', 'go'],
  script: ['sh'],
  config: ['yaml', 'toml', 'ini', 'conf', 'env'],
  app: ['exe', 'msi', 'app', 'deb', 'rpm', 'appimage', 'pkg', 'ipa', 'apk'],
  font: ['ttf', 'otf', 'woff'],
  database: ['db', 'sqlite'],
  cert: ['pem', 'crt'],
  file: ['zzqq', 'bin'],
};

describe('fileCategoryOf', () => {
  for (const [category, exts] of Object.entries(EXPECTED)) {
    it(`puts ${exts.join(' ')} in ${category}`, () => {
      for (const ext of exts) expect(fileCategoryOf(`a.${ext}`), ext).toBe(category);
    });
  }

  it('ignores case, in the extension and in a bare name', () => {
    expect(fileCategoryOf('PHOTO.JPG')).toBe('image');
    expect(fileCategoryOf('Report.PdF')).toBe('pdf');
    expect(fileCategoryOf('Setup.DMG')).toBe('diskImage');
    expect(fileCategoryOf('MAKEFILE')).toBe('code');
  });

  it('reads double extensions by their compound first, then their last', () => {
    expect(fileCategoryOf('backup.tar.gz')).toBe('archive');
    expect(fileCategoryOf('backup.tar.zst')).toBe('archive');
    expect(fileCategoryOf('notes.txt.gz')).toBe('archive');
    expect(fileCategoryOf('types.d.ts')).toBe('code');
    expect(fileCategoryOf('my.photo.final.png')).toBe('image');
  });

  it('reads a dotfile by its name (Rust gives it no extension)', () => {
    expect(fileCategoryOf('.gitignore')).toBe('config');
    expect(fileCategoryOf('.env')).toBe('config');
    expect(fileCategoryOf('.env.local')).toBe('config');
    expect(fileCategoryOf('.bashrc')).toBe('config');
    expect(fileCategoryOf('.eslintrc.json')).toBe('code');
    expect(fileCategoryOf('.DS_Store')).toBe('file');
  });

  it('a name with no extension is a generic file, unless it says what it is', () => {
    expect(fileCategoryOf('data')).toBe('file');
    expect(fileCategoryOf('trove')).toBe('file');
    expect(fileCategoryOf('README')).toBe('text');
    expect(fileCategoryOf('LICENSE')).toBe('text');
    expect(fileCategoryOf('Dockerfile')).toBe('code');
    expect(fileCategoryOf('trailing.')).toBe('file');
    expect(fileCategoryOf('')).toBe('file');
  });

  it('`.key` is Keynote, not a private key', () => {
    expect(fileCategoryOf('Talk.key')).toBe('presentation');
  });
});

describe('the table itself', () => {
  it('no extension sits in two categories', () => {
    const seen = new Map<string, string>();
    for (const [cat, exts] of Object.entries(fileCategoryExtensions)) {
      for (const ext of exts) {
        expect(seen.get(ext), `${ext} in ${cat}`).toBeUndefined();
        seen.set(ext, cat);
      }
    }
  });

  it('extensions are lower case, with no dot in front', () => {
    for (const exts of Object.values(fileCategoryExtensions))
      for (const ext of exts) expect(ext).toMatch(/^[a-z0-9][a-z0-9.]*$/);
  });

  it('every category maps to a glyph that has path data — none can draw a blank', () => {
    expect(Object.keys(fileCategoryIcons).sort()).toEqual([...fileCategories].sort());
    for (const cat of fileCategories) {
      const { glyph, tint } = fileCategoryIcons[cat];
      expect(glyphNames, cat).toContain(glyph);
      expect(glyphIcons[glyph].length, cat).toBeGreaterThan(0);
      expect(tint, cat).toMatch(/^var\(--color-(ftype-[a-z]+|text-secondary)\)$/);
    }
  });

  it('every tint variable is defined in app.css, for light and for dark', async () => {
    const { readFileSync } = await import('node:fs');
    const css = readFileSync('src/app.css', 'utf8');
    const dark = css.slice(css.indexOf(":root[data-theme='dark']"));
    for (const { tint } of Object.values(fileCategoryIcons)) {
      const name = tint.slice(4, -1);
      if (name === '--color-text-secondary') continue;
      expect(css.split(`${name}:`).length - 1, name).toBe(2);
      expect(dark, name).toContain(`${name}:`);
    }
  });
});
