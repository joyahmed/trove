import { describe, expect, it, vi } from 'vitest';

// Home is known (Windows form, like use-folder-header-home.svelte.test.ts).
vi.mock('$lib/api/shell', () => ({
  drives: vi.fn(async () => []),
  knownFolders: vi.fn(async () => []),
  userProfile: vi.fn(async () => 'C:\\Users\\alex'),
  oneDriveRoot: vi.fn(async () => null),
  openTerminal: vi.fn(async () => {}),
}));

import { readFileSync } from 'node:fs';
import { homeFolder } from '$lib/state/home-folder.svelte';
import { detailsRows } from '$lib/data/details-rows';
import type { FileEntry } from '$lib/types/fs';
import type { Props } from '$lib/types/props';
import { previewFacts } from './use-preview-pane.svelte';

const homeKnown = async () => {
  void homeFolder.path;
  await new Promise((r) => setTimeout(r, 0));
  expect(homeFolder.path).toBe('C:\\Users\\alex');
};
const file = {
  name: 'a.txt',
  path: 'C:\\Users\\alex\\docs\\a.txt',
  isDir: false,
  size: 1,
} as FileEntry;
const src = (p: string) => readFileSync(p, 'utf8');

describe('home as ~ in the Location rows (display only)', () => {
  it('preview Information: Location prints ~, its tooltip value stays whole', async () => {
    await homeKnown();
    const loc = previewFacts(file, homeFolder.path).find((f) => f.label === 'Location')!;
    expect(loc.shown).toBe('~\\docs');
    expect(loc.value).toBe('C:\\Users\\alex\\docs');
  });

  it('without a known home the preview shows the whole path', () => {
    const loc = previewFacts(file, null).find((f) => f.label === 'Location')!;
    expect(loc.shown).toBe('C:\\Users\\alex\\docs');
  });

  it('details row: shown is ~, value (tooltip) stays whole', async () => {
    await homeKnown();
    const row = detailsRows.find((r) => r.key === 'location')!;
    const v = row.value({ path: file.path } as Props, null)!;
    expect(v).toBe('C:\\Users\\alex\\docs');
    expect(row.shown!(v, homeFolder.path)).toBe('~\\docs');
  });

  it('a look-alike sibling and an archive location pass through', () => {
    const row = detailsRows.find((r) => r.key === 'location')!;
    expect(row.shown!('C:\\Users\\alexa\\x', 'C:\\Users\\alex')).toBe('C:\\Users\\alexa\\x');
    expect(row.shown!('a.zip › docs', 'C:\\Users\\alex')).toBe('a.zip › docs');
  });

  it('the markup prints shown and keeps the full value as the tooltip', () => {
    const row = src('src/lib/components/panes/details-parts/DetailsRow.svelte');
    expect(row).toContain('title={value}>{shown ?? value}');
    const prev = src('src/lib/components/panes/PreviewPane.svelte');
    expect(prev).toContain('title={fact.value}>{fact.shown ?? fact.value}');
    expect(prev).toContain('previewFacts(entry, homeFolder.path)');
    const card = src('src/lib/components/places/place-view-parts/FileTileCard.svelte');
    expect(card).toContain('title={folder}>{shown}');
  });
});
