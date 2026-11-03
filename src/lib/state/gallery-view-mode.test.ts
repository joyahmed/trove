// Gallery as a view mode of any folder (plan 15 G.52): the folder's own files in the Gallery grid,
// chosen per folder like Details / List / Icons, never the global default.
import { describe, expect, it, vi } from 'vitest';
import type { FileEntry } from '$lib/types/fs';

vi.mock('$lib/api/gallery', () => ({ galleryItems: vi.fn(async () => []) }));
vi.mock('$lib/api/shell', () => ({
  knownFolders: vi.fn(async () => []),
  drives: vi.fn(async () => []),
  quickAccess: vi.fn(async () => []),
}));
vi.mock('$lib/api/fs', () => ({ readDir: vi.fn(), pathKind: vi.fn(async () => 'dir') }));

const { GALLERY_EXTS, OTHER_ITEMS_LABEL, folderGalleryGroups, isGalleryMedia } =
  await import('./gallery.svelte');
const { TabState } = await import('./tab.svelte');
const { settings, sanitize } = await import('./settings.svelte');
const { sanitizeFolderViews } = await import('$lib/utils/folder-views');
const { viewChoicesFor } = await import('$lib/data/nav-actions');
const { galleryMenuFor } = await import('$lib/data/gallery-menu');
const { HOME, pathLocation } = await import('$lib/utils/location');

const entry = (name: string, modifiedMs: number | null, isDir = false): FileEntry => ({
  name,
  path: `E:\\Photos\\${name}`,
  isDir,
  size: 1,
  modifiedMs,
  createdMs: modifiedMs,
  ext: isDir ? null : (name.split('.').pop() ?? null),
  isHidden: false,
  iconKey: isDir ? 'folder' : 'ext/jpg',
  typeName: 'File',
});

const sep = new Date(2026, 8, 20).getTime();
const aug = new Date(2026, 7, 3).getTime();

describe('isGalleryMedia', () => {
  it('is the photo and video kinds, any case, never a folder', () => {
    expect(isGalleryMedia(entry('a.JPG', 1))).toBe(true);
    expect(isGalleryMedia(entry('IMG_1.heic', 1))).toBe(true);
    expect(isGalleryMedia(entry('clip.mov', 1))).toBe(true);
    expect(isGalleryMedia(entry('notes.txt', 1))).toBe(false);
    expect(isGalleryMedia(entry('README', 1))).toBe(false);
    expect(isGalleryMedia(entry('trip.jpg', 1, true))).toBe(false);
  });

  it('the list is exactly the one Rust walks for the Gallery (gallery.rs GALLERY_EXTS)', async () => {
    const { readFileSync } = await import('node:fs');
    const rust = readFileSync('src-tauri/src/core/gallery.rs', 'utf8');
    const decl = rust.match(/pub const GALLERY_EXTS: \[&str; \d+\] = \[([^\]]*)\];/);
    expect(decl, 'GALLERY_EXTS is declared in gallery.rs').not.toBeNull();
    const exts = [...(decl?.[1] ?? '').matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    expect([...GALLERY_EXTS]).toEqual(exts);
  });
});

describe('folderGalleryGroups', () => {
  it('photos newest first by month, then the other items in folder order under one heading', () => {
    const groups = folderGalleryGroups([
      entry('Sub', null, true),
      entry('old.jpg', aug),
      entry('notes.txt', sep),
      entry('new.png', sep),
      entry('undated.mov', null),
    ]);
    expect(groups.map((g) => [g.key, g.items.map((e) => e.name)])).toEqual([
      ['2026-09', ['new.png']],
      ['2026-08', ['old.jpg']],
      ['unknown', ['undated.mov']],
      ['other', ['Sub', 'notes.txt']],
    ]);
    expect(groups.at(-1)?.label).toBe(OTHER_ITEMS_LABEL);
  });

  it('a folder with no photos is all "other"; an empty folder has no groups', () => {
    expect(folderGalleryGroups([entry('a.txt', 1)]).map((g) => g.key)).toEqual(['other']);
    expect(folderGalleryGroups([])).toEqual([]);
  });
});

describe('Gallery view per folder', () => {
  it('a folder set to Gallery shows the grid, not the list; another folder is untouched', () => {
    settings.folderViews = [];
    settings.view = 'details';
    const tab = new TabState();
    tab.location = pathLocation('E:\\Photos');
    tab.setView('gallery');
    expect([tab.view, tab.showsGallery, tab.showsList]).toEqual(['gallery', true, false]);
    tab.location = pathLocation('E:\\Docs');
    expect([tab.view, tab.showsGallery, tab.showsList]).toEqual(['details', false, true]);
    tab.location = pathLocation('E:\\Photos');
    expect(tab.showsGallery).toBe(true);
    // never the global default
    expect(settings.view).toBe('details');
    settings.folderViews = [];
  });

  it('a place cannot be put in Gallery view, so the global default never becomes it', () => {
    settings.folderViews = [];
    settings.view = 'grid';
    const tab = new TabState();
    tab.location = HOME;
    tab.setView('gallery');
    expect(settings.view).toBe('grid');
    expect(tab.showsGallery).toBe(false);
    settings.view = 'details';
  });

  it('is kept in the per-folder store and refused as the global default when read back', () => {
    const kept = sanitizeFolderViews([
      { path: 'E:\\Photos', sortKey: 'name', sortDir: 'asc', groupKey: null, view: 'gallery' },
    ]);
    expect(kept[0]?.view).toBe('gallery');
    expect(sanitize({ view: 'gallery' }).view).not.toBe('gallery');
  });

  it('the toolbar offers Gallery only in a real folder', () => {
    expect(viewChoicesFor(true).map((c) => c.key)).toContain('gallery');
    expect(viewChoicesFor(false).map((c) => c.key)).not.toContain('gallery');
    expect(viewChoicesFor(false).map((c) => c.key)).toEqual(['grid', 'list', 'details']);
  });

  it('a folder gallery item has no "Open file location" (it is already there)', () => {
    const open = vi.fn();
    const reveal = vi.fn();
    const e = entry('a.jpg', 1);
    expect(galleryMenuFor(e, { open, reveal }).map((i) => i.key)).toEqual(['open', 'reveal']);
    expect(galleryMenuFor(e, { open }).map((i) => i.key)).toEqual(['open']);
  });
});
