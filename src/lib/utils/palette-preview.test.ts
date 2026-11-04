import { describe, expect, it } from 'vitest';
import type { PaletteResult } from '$lib/types/palette';
import {
  copyPathForms,
  folderCountLabel,
  isPreviewable,
  PALETTE_LIST_MIN,
  palettePreviewFits,
  previewToggle,
  renameProblem,
} from './palette-preview';

const key = (
  k: string,
  mods: Partial<Record<'altKey' | 'ctrlKey' | 'metaKey' | 'shiftKey', boolean>> = {},
) => ({
  key: k,
  altKey: false,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  ...mods,
});

describe('previewToggle (plan 04 4.4: Alt+→ / Alt+←)', () => {
  it('Alt+→ shows the pane and Alt+← hides it', () => {
    expect(previewToggle(key('ArrowRight', { altKey: true }))).toBe('show');
    expect(previewToggle(key('ArrowLeft', { altKey: true }))).toBe('hide');
  });

  it('leaves plain arrows to the input and every other Alt chord alone', () => {
    expect(previewToggle(key('ArrowRight'))).toBeNull();
    expect(previewToggle(key('ArrowUp', { altKey: true }))).toBeNull();
    expect(previewToggle(key('p', { altKey: true }))).toBeNull();
  });

  it('is plain Alt only: AltGr (Ctrl+Alt), ⌘ and Shift+Alt word-select are not the toggle', () => {
    expect(previewToggle(key('ArrowRight', { altKey: true, ctrlKey: true }))).toBeNull();
    expect(previewToggle(key('ArrowRight', { altKey: true, metaKey: true }))).toBeNull();
    expect(previewToggle(key('ArrowLeft', { altKey: true, shiftKey: true }))).toBeNull();
  });
});

describe('isPreviewable', () => {
  const row = (extra: Partial<PaletteResult>): PaletteResult => ({
    key: 'k',
    category: 'files',
    title: 't',
    detail: '',
    run: () => {},
    ...extra,
  });
  it('is true only for a row with a path on disk', () => {
    expect(isPreviewable(row({ previewPath: 'C:\\a.txt' }))).toBe(true);
    expect(isPreviewable(row({}))).toBe(false);
    expect(isPreviewable(row({ previewPath: '' }))).toBe(false);
    expect(isPreviewable(undefined)).toBe(false);
  });
});

describe('copyPathForms (Copy path, both forms for WSL)', () => {
  it('offers one form for an ordinary path', () => {
    expect(copyPathForms('C:\\Users\\alex\\a.txt')).toEqual([
      { key: 'path', label: 'Copy path', text: 'C:\\Users\\alex\\a.txt' },
    ]);
    expect(copyPathForms('/Users/alex/a.txt').map((f) => f.key)).toEqual(['path']);
  });

  it('offers the Windows and the distro:/ form for a WSL share, as copyAsPath writes them', () => {
    expect(copyPathForms('\\\\wsl.localhost\\Ubuntu\\home\\alex\\a.txt')).toEqual([
      { key: 'path', label: 'Copy path', text: '\\\\wsl.localhost\\Ubuntu\\home\\alex\\a.txt' },
      { key: 'linux', label: 'Copy Linux path', text: 'Ubuntu:/home/alex/a.txt' },
    ]);
  });
});

describe('renameProblem', () => {
  it('accepts a name, trimmed', () => {
    expect(renameProblem('  report.md ')).toBeNull();
  });
  it('refuses an empty name and a path separator', () => {
    expect(renameProblem('   ')).toBe('Type a name.');
    expect(renameProblem('a/b')).toMatch(/cannot contain/);
    expect(renameProblem('a\\b')).toMatch(/cannot contain/);
  });
});

describe('folderCountLabel', () => {
  it('counts items, singular for one, nothing while unknown', () => {
    expect(folderCountLabel(null)).toBeNull();
    expect(folderCountLabel(1)).toBe('1 item');
    expect(folderCountLabel(0)).toBe('0 items');
    expect(folderCountLabel(12)).toBe('12 items');
  });
});

describe('palettePreviewFits', () => {
  it('fits in the Spotlight window (680) at the widest pane (400): the list keeps 280', () => {
    expect(palettePreviewFits(680, 400)).toBe(true);
    expect(680 - 400).toBe(PALETTE_LIST_MIN);
  });

  it('fits in an 800 px window panel (768 px of room) at every pane width', () => {
    expect(palettePreviewFits(768, 240)).toBe(true);
    expect(palettePreviewFits(768, 400)).toBe(true);
  });

  it('hides rather than squeeze the list: 800 px at a large text size is ~488 px of room', () => {
    expect(palettePreviewFits(488, 320)).toBe(false);
    expect(palettePreviewFits(488, 240)).toBe(false);
    expect(palettePreviewFits(520, 240)).toBe(true);
  });
});
