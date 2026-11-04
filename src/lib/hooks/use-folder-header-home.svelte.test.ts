import { describe, expect, it, vi } from 'vitest';

// The home folder is known (Windows form: tests run as Windows, like every switch in platform.ts).
vi.mock('$lib/api/shell', () => ({
  drives: vi.fn(async () => []),
  knownFolders: vi.fn(async () => []),
  userProfile: vi.fn(async () => 'C:\\Users\\alex'),
  oneDriveRoot: vi.fn(async () => null),
  openTerminal: vi.fn(async () => {}),
}));
vi.mock('$lib/api/fs', () => ({
  readDir: vi.fn(async (path: string) => ({ path, entries: [] })),
  pathKind: vi.fn(async () => 'dir'),
}));
vi.mock('$lib/api/archive', () => ({ readArchiveDir: vi.fn() }));
const writeText = vi.fn<(paths: string[]) => Promise<void>>(async () => {});
vi.mock('$lib/api/clipboard', () => ({
  clipboardWritePaths: vi.fn(async () => {}),
  clipboardWritePathsText: (paths: string[]) => writeText(paths),
  clipboardReadPaths: vi.fn(async () => null),
}));

import { readFileSync } from 'node:fs';
import { pathLocation } from '$lib/utils/location';
import { tabs } from '$lib/state/tabs.svelte';
import { actions } from '$lib/state/actions.svelte';
import { selection } from '$lib/state/selection.svelte';
import { homeFolder } from '$lib/state/home-folder.svelte';
import { pathColumn } from '$lib/data/file-columns';
import { settings } from '$lib/state/settings.svelte';
import type { FileEntry } from '$lib/types/fs';
import { useFolderHeader } from './use-folder-header.svelte';

const homeKnown = async () => {
  void homeFolder.path;
  await new Promise((r) => setTimeout(r, 0));
  expect(homeFolder.path).toBe('C:\\Users\\alex');
};

describe('home as ~ in the display places only', () => {
  it('the folder header line shows ~, its tooltip and the tab keep the full path', async () => {
    await homeKnown();
    tabs.active.location = pathLocation('C:\\Users\\alex\\trove-demo');
    const h = useFolderHeader();
    expect(h.path).toBe('~\\trove-demo');
    expect(h.meta).toBe('C:\\Users\\alex\\trove-demo · 0 items');
    expect(tabs.active.path).toBe('C:\\Users\\alex\\trove-demo');
  });

  it('a look-alike sibling of home stays whole in the header', async () => {
    await homeKnown();
    tabs.active.location = pathLocation('C:\\Users\\alexa\\x');
    expect(useFolderHeader().path).toBe('C:\\Users\\alexa\\x');
  });

  it('the search Folder column shows ~', async () => {
    await homeKnown();
    const e = { path: 'C:\\Users\\alex\\docs\\a.txt' } as FileEntry;
    expect(pathColumn.cell(e, settings)).toBe('~\\docs');
  });

  it('Copy path still copies the full path inside home', async () => {
    await homeKnown();
    tabs.active.location = pathLocation('C:\\Users\\alex\\trove-demo');
    selection.clear();
    const p = 'C:\\Users\\alex\\trove-demo\\a.txt';
    selection.click(p, { ctrl: true, shift: false }, [p]);
    await actions.copyAsPath();
    expect(writeText).toHaveBeenCalledWith([p]);
  });

  it('the palette row prints its detail through tildeHome, not the raw path', () => {
    const src = readFileSync('src/lib/components/palette/palette-parts/ResultRow.svelte', 'utf8');
    expect(src).toContain('tildeHome(item.detail, homeFolder.path)');
    const markup = src.replace(/<script[\s\S]*?<\/script>/g, '');
    expect(markup).toContain('{detail}');
    expect(markup).not.toContain('{item.detail}');
  });
});
