import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { glyphIcons } from './glyph-icons';
import { glyphAliases, glyphNames } from './glyphs';

describe('icon data', () => {
  it('has path data for every name, and for no other', () => {
    expect(Object.keys(glyphIcons).sort()).toEqual([...glyphNames].sort());
    for (const name of glyphNames) {
      const paths = glyphIcons[name];
      expect(paths.length, name).toBeGreaterThan(0);
      for (const d of paths) expect(d.trim().length, name).toBeGreaterThan(3);
    }
  });

  it('every path starts with a move command, so one <path d> draws it', () => {
    for (const name of glyphNames)
      for (const d of glyphIcons[name]) expect(d, name).toMatch(/^[Mm]/);
  });

  it('every alias resolves to the same drawing as its target', () => {
    for (const [alias, target] of Object.entries(glyphAliases)) {
      expect(glyphNames).toContain(alias);
      expect(glyphNames).toContain(target);
      expect(glyphIcons[alias as keyof typeof glyphIcons]).toEqual(glyphIcons[target]);
    }
    expect(Object.keys(glyphAliases)).toHaveLength(3);
  });

  it('names are unique', () => {
    expect(new Set(glyphNames).size).toBe(glyphNames.length);
  });
});

describe('no icon font is left', () => {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(ts|svelte|css)$/.test(entry)) files.push(p);
    }
  };
  walk('src');

  it('no source file defines a code point glyph or reads the icon font', () => {
    for (const file of files) {
      if (file.endsWith('glyphs.test.ts')) continue;
      const text = readFileSync(file, 'utf8');
      expect(text, file).not.toContain('glyph(0x');
      expect(text, file).not.toContain('font-icons');
      expect(text, file).not.toMatch(/[-]/);
    }
  });
});
