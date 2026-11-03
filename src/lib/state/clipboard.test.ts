import { beforeEach, describe, expect, it, vi } from 'vitest';
import { clipboard } from './clipboard.svelte';
import { clipboardReadPaths, clipboardWritePaths } from '$lib/api/clipboard';

vi.mock('$lib/api/clipboard', () => ({
  clipboardWritePaths: vi.fn(async () => {}),
  clipboardReadPaths: vi.fn(async () => null),
}));

const settle = () => new Promise((r) => setTimeout(r, 0));

describe('clipboard', () => {
  beforeEach(() => {
    clipboard.clear();
    vi.mocked(clipboardWritePaths).mockResolvedValue(undefined);
    vi.mocked(clipboardReadPaths).mockResolvedValue(null);
  });

  it('holds paths with the cut flag and mirrors them to the OS clipboard', () => {
    clipboard.set(['C:\\a.txt', 'C:\\b.txt'], true);
    expect(clipboard.has).toBe(true);
    expect(clipboard.isCut('C:\\a.txt')).toBe(true);
    expect(clipboard.isCut('C:\\zzz.txt')).toBe(false);
    expect(clipboardWritePaths).toHaveBeenCalledWith(['C:\\a.txt', 'C:\\b.txt'], true);
  });

  it('a copy is not cut, and clear empties everything', () => {
    clipboard.set(['C:\\a.txt'], false);
    expect(clipboard.isCut('C:\\a.txt')).toBe(false);
    clipboard.clear();
    expect(clipboard.has).toBe(false);
    expect(clipboard.cut).toBe(false);
  });

  it('read keeps our cut flag while the OS clipboard still holds our list', async () => {
    clipboard.set(['C:\\a.txt'], true);
    await settle();
    vi.mocked(clipboardReadPaths).mockResolvedValue({ paths: ['C:\\a.txt'], cut: false });
    expect(await clipboard.read()).toEqual({ paths: ['C:\\a.txt'], cut: true });
  });

  it('a copy made in Explorer since beats our old list', async () => {
    clipboard.set(['C:\\old.txt'], false);
    await settle();
    vi.mocked(clipboardReadPaths).mockResolvedValue({ paths: ['D:\\new.txt'], cut: false });
    expect(await clipboard.read()).toEqual({ paths: ['D:\\new.txt'], cut: false });
    expect(clipboard.has).toBe(false);
  });

  it('after Copy as path (text only) there are no files to paste, and cut rows un-dim', async () => {
    clipboard.set(['C:\\a.txt'], true);
    await settle();
    vi.mocked(clipboardReadPaths).mockResolvedValue(null);
    await clipboard.verify();
    expect(clipboard.isCut('C:\\a.txt')).toBe(false);
    clipboard.set(['C:\\a.txt'], false);
    await settle();
    expect(await clipboard.read()).toBeNull();
  });

  it('a list the OS refused to take stays ours', async () => {
    vi.mocked(clipboardWritePaths).mockRejectedValueOnce(new Error('busy'));
    clipboard.set(['C:\\a.txt'], false);
    await settle();
    expect(await clipboard.read()).toEqual({ paths: ['C:\\a.txt'], cut: false });
  });

  it('an OS clipboard that cannot be asked changes nothing', async () => {
    clipboard.set(['C:\\a.txt'], true);
    await settle();
    vi.mocked(clipboardReadPaths).mockRejectedValue(new Error('x'));
    await clipboard.verify();
    expect(clipboard.has).toBe(true);
  });

  it('read falls back to the OS clipboard, and to nothing', async () => {
    vi.mocked(clipboardReadPaths).mockResolvedValue({ paths: ['D:\\x.png'], cut: false });
    expect(await clipboard.read()).toEqual({ paths: ['D:\\x.png'], cut: false });
    vi.mocked(clipboardReadPaths).mockResolvedValue({ paths: [], cut: false });
    expect(await clipboard.read()).toBeNull();
    vi.mocked(clipboardReadPaths).mockRejectedValue(new Error('no clipboard'));
    expect(await clipboard.read()).toBeNull();
  });
});

describe('clipboard: a copy inside an archive (plan 16, Phase 4)', () => {
  beforeEach(() => {
    clipboard.clear();
    vi.mocked(clipboardWritePaths).mockClear();
    vi.mocked(clipboardReadPaths).mockResolvedValue(null);
  });

  it('setArchive holds the entries, empties paths and never writes the OS clipboard', async () => {
    clipboard.set(['/home/j/x.txt'], true);
    vi.mocked(clipboardWritePaths).mockClear();
    clipboard.setArchive('/home/j/a.zip', ['docs/a.txt']);
    expect(clipboard.archive).toEqual({ archive: '/home/j/a.zip', entries: ['docs/a.txt'] });
    expect(clipboard.paths).toEqual([]);
    expect(clipboard.cut).toBe(false);
    expect(clipboardWritePaths).not.toHaveBeenCalled();
    await settle();
    expect(await clipboard.readArchive()).toEqual(clipboard.archive);
  });

  it('clear and a later ordinary copy both drop it', () => {
    clipboard.setArchive('/home/j/a.zip', ['a.txt']);
    clipboard.clear();
    expect(clipboard.archive).toBeNull();
    clipboard.setArchive('/home/j/a.zip', ['a.txt']);
    clipboard.set(['/home/j/x.txt'], false);
    expect(clipboard.archive).toBeNull();
  });

  it('a file copy in another app since then drops it', async () => {
    clipboard.setArchive('/home/j/a.zip', ['a.txt']);
    await settle();
    vi.mocked(clipboardReadPaths).mockResolvedValue({ paths: ['/home/j/y.txt'], cut: false });
    expect(await clipboard.readArchive()).toBeNull();
    expect(clipboard.archive).toBeNull();
  });
});
