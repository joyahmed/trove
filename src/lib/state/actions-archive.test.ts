// Plan 16, Phase 4: an archive browsed like a folder is read-only. Open goes inside (or out
// to a temp copy for a file), Copy holds entries that a Paste in a real folder extracts, and
// nothing that writes — Delete, F2, Cut, Paste-into, New — acts there. No real files.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { actions } from './actions.svelte';
import { clipboard } from './clipboard.svelte';
import { drag } from './drag.svelte';
import { selection } from './selection.svelte';
import { settings } from './settings.svelte';
import { tabs } from './tabs.svelte';
import { transfers } from './transfers.svelte';
import { confirm } from './confirm.svelte';
import { pathLocation } from '$lib/utils/location';
import { archiveLocation } from '$lib/utils/archive-location';
import { dropPathOf } from '$lib/utils/app-bundle';
import * as fs from '$lib/api/fs';
import { archiveConflicts, startExtract, startExtractHere, startOpenInner } from '$lib/api/archive';
import { clipboardReadPaths, clipboardWritePaths } from '$lib/api/clipboard';
import type { FileEntry } from '$lib/types/fs';

vi.mock('$lib/api/fs', () => ({
  readDir: vi.fn(async (path: string) => ({ path, entries: [] })),
  deleteEntries: vi.fn(async () => {}),
  trashEntries: vi.fn(async () => {}),
  createFolder: vi.fn(async () => ''),
  createFile: vi.fn(async () => ''),
  renameEntry: vi.fn(async () => ''),
  openPath: vi.fn(async () => {}),
  pathKind: vi.fn(async () => 'file'),
}));
vi.mock('$lib/api/shell', () => ({
  drives: vi.fn(async () => []),
  knownFolders: vi.fn(async () => []),
  oneDriveRoot: vi.fn(async () => null),
  openTerminal: vi.fn(async () => {}),
}));
vi.mock('$lib/api/transfer', () => ({
  restoreFromTrash: vi.fn(async () => {}),
  transferConflicts: vi.fn(async () => []),
  startTransfer: vi.fn(async () => 1),
  cancelTransfer: vi.fn(async () => {}),
  onTransferProgress: vi.fn(async () => () => {}),
  onTransferDone: vi.fn(async () => () => {}),
  dragOut: vi.fn(async () => 'none'),
  sameVolume: vi.fn(async () => true),
}));
vi.mock('$lib/api/archive', () => ({
  archiveConflicts: vi.fn(async () => []),
  startExtract: vi.fn(async () => 1),
  startExtractHere: vi.fn(async () => 1),
  startCompress: vi.fn(async () => 1),
  readArchiveDir: vi.fn(async (archive: string) => ({ path: archive, entries: [] })),
  startOpenInner: vi.fn(async () => 'C:\\cache\\archive-open\\ab12\\a.txt'),
}));
vi.mock('$lib/api/clipboard', () => ({
  clipboardWritePaths: vi.fn(async () => {}),
  clipboardReadPaths: vi.fn(async () => null),
  clipboardWritePathsText: vi.fn(async () => {}),
}));

const ZIP = 'C:\\t\\a.zip';
const row = (name: string, path: string, isDir: boolean): FileEntry => ({
  name,
  path,
  isDir,
  size: 1,
  modifiedMs: null,
  createdMs: null,
  ext: null,
  isHidden: false,
  iconKey: isDir ? 'folder' : 'ext/txt',
  typeName: 'File',
});
const inside = (inner: string, isDir = false) =>
  row(inner.split('/').at(-1) ?? inner, `${ZIP}\u0000${inner}`, isDir);

const settle = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
  clipboard.clear();
  selection.clear();
  transfers.pending = null;
  settings.archivesOpenInside = true;
});

describe('opening an archive', () => {
  beforeEach(() => {
    tabs.active.location = pathLocation('C:\\t');
  });

  it('double-click a zip navigates inside it', async () => {
    const navigate = vi.spyOn(tabs.active, 'navigate').mockResolvedValue();
    await actions.open(row('a.zip', ZIP, false));
    expect(navigate).toHaveBeenCalledWith(archiveLocation(ZIP));
    expect(fs.openPath).not.toHaveBeenCalled();
  });

  it('with the setting off it opens in its app, as before', async () => {
    settings.archivesOpenInside = false;
    const navigate = vi.spyOn(tabs.active, 'navigate').mockResolvedValue();
    await actions.open(row('a.zip', ZIP, false));
    expect(navigate).not.toHaveBeenCalled();
    expect(fs.openPath).toHaveBeenCalledWith(ZIP);
  });

  it('a bare .gz is one compressed file: it opens in its app', async () => {
    await actions.open(row('a.gz', 'C:\\t\\a.gz', false));
    expect(fs.openPath).toHaveBeenCalledWith('C:\\t\\a.gz');
  });

  it('middle-click a zip opens it inside in a new tab', () => {
    const open = vi.spyOn(tabs, 'open').mockImplementation(() => tabs.active);
    actions.openInNewTab(row('a.zip', ZIP, false));
    expect(open).toHaveBeenCalledWith(archiveLocation(ZIP));
  });
});

describe('inside an archive', () => {
  beforeEach(() => {
    tabs.active.location = archiveLocation(ZIP, 'docs');
    tabs.active.entries = [inside('docs/sub', true), inside('docs/a.txt')];
  });

  it('a folder navigates to the inner folder', async () => {
    const navigate = vi.spyOn(tabs.active, 'navigate').mockResolvedValue();
    await actions.open(inside('docs/sub', true));
    expect(navigate).toHaveBeenCalledWith(archiveLocation(ZIP, 'docs/sub'));
  });

  it('a file is extracted to a temp copy, and that copy opens', async () => {
    await actions.open(inside('docs/a.txt'));
    expect(startOpenInner).toHaveBeenCalledWith(ZIP, 'docs/a.txt');
    expect(fs.openPath).toHaveBeenCalledWith('C:\\cache\\archive-open\\ab12\\a.txt');
  });

  it('Delete, Shift+Delete, F2, Cut, New folder and Paste-into call nothing', async () => {
    selection.replaceAll([`${ZIP}\u0000docs/a.txt`]);
    await actions.deleteSelected();
    await actions.deletePermanently();
    actions.startRename(`${ZIP}\u0000docs/a.txt`);
    actions.cut();
    await actions.newFolder();
    clipboard.set(['C:\\other\\x.txt'], false);
    await actions.paste();
    expect(fs.trashEntries).not.toHaveBeenCalled();
    expect(fs.deleteEntries).not.toHaveBeenCalled();
    expect(fs.createFolder).not.toHaveBeenCalled();
    expect(actions.renaming).toBeNull();
    expect(transfers.pending).toBeNull();
    expect(startExtract).not.toHaveBeenCalled();
  });

  it('Copy holds the inner entries and never writes the OS clipboard', () => {
    selection.replaceAll([`${ZIP}\u0000docs/a.txt`, `${ZIP}\u0000docs/sub`]);
    actions.copy();
    // in the order the list shows them (folders first)
    expect(clipboard.archive).toEqual({ archive: ZIP, entries: ['docs/sub', 'docs/a.txt'] });
    expect(clipboard.paths).toEqual([]);
    expect(clipboardWritePaths).not.toHaveBeenCalled();
  });

  it('Copy takes exactly the selected rows shown: nothing selected copies nothing', () => {
    clipboard.setArchive(ZIP, ['old/kept.txt']);
    selection.clear();
    actions.copy();
    expect(actions.canCopy).toBe(false);
    // an earlier copy is left as it was, never replaced by some other set
    expect(clipboard.archive).toEqual({ archive: ZIP, entries: ['old/kept.txt'] });
  });

  it('Copy ignores a stale selection from another inner folder or another archive', () => {
    // the selection outlives a navigation until `selection.retain` runs on the new listing
    selection.replaceAll([
      `${ZIP}\u0000other/b.txt`,
      `C:\\t\\b.zip\u0000docs/a.txt`,
      'C:\\t\\real.txt',
      `${ZIP}\u0000docs/a.txt`,
    ]);
    actions.copy();
    expect(clipboard.archive).toEqual({ archive: ZIP, entries: ['docs/a.txt'] });
  });

  it('Copy with only stale entries selected copies nothing', () => {
    selection.replaceAll([`${ZIP}\u0000other/b.txt`]);
    expect(actions.canCopy).toBe(false);
    actions.copy();
    expect(clipboard.archive).toBeNull();
  });

  it('a folder inside is never a drop target, and its rows do not start a drag', () => {
    expect(dropPathOf(inside('docs/sub', true))).toBeUndefined();
    drag.start([`${ZIP}\u0000docs/a.txt`], 10, 10);
    expect(drag.paths).toEqual([]);
  });
});

describe('paste of an archive copy into a real folder', () => {
  beforeEach(() => {
    tabs.active.location = archiveLocation(ZIP, 'docs');
    selection.replaceAll([`${ZIP}\u0000docs/a.txt`]);
    actions.copy();
    tabs.active.location = pathLocation('C:\\Desktop');
  });

  it('starts one extract job with those entries', async () => {
    await actions.paste();
    await settle();
    expect(startExtract).toHaveBeenCalledTimes(1);
    expect(vi.mocked(startExtract).mock.calls[0].slice(0, 3)).toEqual([
      ZIP,
      'C:\\Desktop',
      ['docs/a.txt'],
    ]);
  });

  it('asks the conflict question first when a name is taken', async () => {
    vi.mocked(archiveConflicts).mockResolvedValueOnce([{ name: 'a.txt', isDir: false } as never]);
    await actions.paste();
    expect(startExtract).not.toHaveBeenCalled();
    expect(transfers.pending?.extract).toEqual({ archive: ZIP, entries: ['docs/a.txt'] });
  });

  it('a file copy made in another app since then wins', async () => {
    await settle(); // the clip noted the OS clipboard as empty
    vi.mocked(clipboardReadPaths).mockResolvedValue({ paths: ['C:\\x\\y.txt'], cut: false });
    await actions.paste();
    expect(startExtract).not.toHaveBeenCalled();
    expect(clipboard.archive).toBeNull();
  });
});

describe('Extract all…', () => {
  const ZIP2 = 'E:\\in\\photos.zip';
  beforeEach(() => {
    confirm.pending = null;
    tabs.active.location = pathLocation('E:\\in');
    tabs.active.entries = [row('photos.zip', ZIP2, false)];
    selection.replaceAll([ZIP2]);
  });

  it('is offered for one selected archive only', () => {
    expect(actions.canExtractHere).toBe(true);
    selection.clear();
    expect(actions.canExtractHere).toBe(false);
  });

  it('asks for a folder, starting at the archive folder, and extracts the whole archive there', async () => {
    vi.mocked(fs.pathKind).mockResolvedValue('dir');
    const done = actions.extractAll();
    await settle();
    expect(confirm.pending?.title).toBe('Extract all…');
    expect(confirm.text).toBe('E:\\in');
    confirm.text = 'F:\\stick';
    confirm.answer(true);
    await done;
    await settle();
    expect(fs.pathKind).toHaveBeenCalledWith('F:\\stick');
    expect(archiveConflicts).toHaveBeenCalledWith(ZIP2, 'F:\\stick', null);
    expect(vi.mocked(startExtract).mock.calls[0].slice(0, 3)).toEqual([ZIP2, 'F:\\stick', null]);
    expect(startExtractHere).not.toHaveBeenCalled();
  });

  it('Cancel starts nothing', async () => {
    const done = actions.extractAll();
    await settle();
    confirm.answer(false);
    await done;
    expect(startExtract).not.toHaveBeenCalled();
    expect(fs.pathKind).not.toHaveBeenCalled();
  });

  it('a path that is not typed in full is refused by the box itself', async () => {
    const done = actions.extractAll();
    await settle();
    confirm.text = 'stick';
    confirm.answer(true);
    expect(confirm.pending).not.toBeNull();
    expect(confirm.problem).toMatch(/full path/);
    confirm.answer(false);
    await done;
    expect(startExtract).not.toHaveBeenCalled();
  });

  it('a path that is not an existing folder asks again and extracts nothing yet', async () => {
    vi.mocked(fs.pathKind).mockResolvedValueOnce('missing');
    const done = actions.extractAll();
    await settle();
    confirm.text = 'F:\\nope';
    confirm.answer(true);
    await settle();
    expect(startExtract).not.toHaveBeenCalled();
    expect(confirm.pending?.title).toBe('Extract all…');
    expect(confirm.text).toBe('F:\\nope');
    confirm.answer(false);
    await done;
  });

  it('conflicts in the folder raise the Replace / Skip / Keep both question', async () => {
    vi.mocked(fs.pathKind).mockResolvedValue('dir');
    vi.mocked(archiveConflicts).mockResolvedValueOnce([{ name: 'a.txt', isDir: false } as never]);
    const done = actions.extractAll();
    await settle();
    confirm.answer(true);
    await done;
    expect(startExtract).not.toHaveBeenCalled();
    expect(transfers.pending?.destination).toBe('E:\\in');
    expect(transfers.pending?.extract).toEqual({ archive: ZIP2, entries: null });
  });
});
