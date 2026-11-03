// A tab on a place draws that place's own icon — the one its sidebar row draws — not the yellow
// folder (the Mac, 2026-10-08: Trash, This PC and Home tabs showed a folder).
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

vi.mock('$lib/api/shell', () => ({
  drives: vi.fn(async () => []),
  knownFolders: vi.fn(async () => []),
  userProfile: vi.fn(async () => null),
  oneDriveRoot: vi.fn(async () => null),
  openTerminal: vi.fn(async () => {}),
}));
vi.mock('$lib/api/wsl', () => ({
  wslDistros: vi.fn(async () => []),
  wslHome: vi.fn(async () => ''),
}));

import { PLACE_ICONS, placeIconFor } from './place-icons';
import { sidebarSections } from './sidebar-sections';
import type { PlaceKind } from '$lib/types/location';

describe('placeIconFor', () => {
  it('the Bin, This PC and Home get their own glyph, never the folder', () => {
    expect(placeIconFor({ kind: 'recycle-bin' })?.glyph).toBe('delete');
    expect(placeIconFor({ kind: 'this-pc' })?.glyph).toBe('thisPc');
    expect(placeIconFor({ kind: 'home' })?.glyph).toBe('home');
    expect(placeIconFor({ kind: 'gallery' })?.glyph).toBe('gallery');
    expect(placeIconFor({ kind: 'applications' })?.glyph).toBe('fileApp');
  });

  it('a folder or an archive keeps the yellow folder (null)', () => {
    expect(placeIconFor({ kind: 'path', path: 'C:\\x' })).toBeNull();
    expect(placeIconFor({ kind: 'archive', archive: 'C:\\a.zip', inner: '' })).toBeNull();
  });

  it('every place row in the sidebar draws the same glyph and colour as its tab', () => {
    const rows = sidebarSections.flatMap((s) => s.items());
    const kinds: PlaceKind[] = ['home', 'gallery', 'applications', 'recycle-bin'];
    for (const kind of kinds) {
      const row = rows.find((r) => r.location?.kind === kind);
      expect(row, kind).toBeDefined();
      expect({ glyph: row?.glyph, color: row?.color }, kind).toEqual(PLACE_ICONS[kind]);
    }
  });

  it('the tab strip and its drag ghost draw the place icon when there is one', () => {
    const src = readFileSync(
      new URL('../components/shell/shell-parts/TabStrip.svelte', import.meta.url),
      'utf8',
    );
    expect(src).toMatch(/\{#if tab\.icon\}/);
    expect(src).toMatch(/\{#if strip\.ghost\.icon\}/);
  });
});
