import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  archiveLocation,
  archiveText,
  archiveWindowTarget,
  crumbsOfArchive,
  isArchivePath,
  isBrowsableArchive,
  labelOfArchive,
  parentOfArchive,
  parseArchiveText,
  sameArchiveLocation,
  splitArchivePath,
  archivePathCrumbs,
  archiveRowFolder,
  archiveRowWhere,
} from './archive-location';

const LINUX = { os: 'linux', thisPcLabel: 'This Computer' } as const;

afterEach(() => vi.unstubAllGlobals());

describe('isBrowsableArchive', () => {
  it('zip, 7z and the tar family browse; a bare .gz and other files do not', () => {
    for (const n of ['a.zip', 'B.ZIP', 'a.7z', 'a.tar', 'a.tar.gz', 'a.tgz', 'a.tar.xz', 'a.tzst'])
      expect(isBrowsableArchive(n), n).toBe(true);
    for (const n of ['a.gz', 'a.txt', 'zip', 'a.zip.txt', 'a.rar'])
      expect(isBrowsableArchive(n), n).toBe(false);
  });
});

describe('archiveLocation', () => {
  it('cleans the inner path to `/`-separated with no outer separators', () => {
    expect(archiveLocation('C:\\x\\a.zip', '\\docs\\sub\\')).toEqual({
      kind: 'archive',
      archive: 'C:\\x\\a.zip',
      inner: 'docs/sub',
    });
    expect(archiveLocation('C:\\x\\a.zip').inner).toBe('');
  });

  it('same archive compares by samePath (Windows: any case), inner exactly', () => {
    const a = archiveLocation('C:\\X\\A.zip', 'docs');
    expect(sameArchiveLocation(a, archiveLocation('c:\\x\\a.zip', 'docs'))).toBe(true);
    expect(sameArchiveLocation(a, archiveLocation('C:\\X\\A.zip', ''))).toBe(false);
  });
});

describe('parentOfArchive (Up)', () => {
  it('nested inner folder → the one above it, still inside', () => {
    expect(parentOfArchive(archiveLocation('C:\\x\\a.zip', 'docs/sub'))).toEqual(
      archiveLocation('C:\\x\\a.zip', 'docs'),
    );
    expect(parentOfArchive(archiveLocation('C:\\x\\a.zip', 'docs'))).toEqual(
      archiveLocation('C:\\x\\a.zip', ''),
    );
  });

  it("the archive's top → the real folder holding it (Windows and POSIX)", () => {
    expect(parentOfArchive(archiveLocation('C:\\x\\a.zip'))).toEqual({
      kind: 'path',
      path: 'C:\\x',
    });
    expect(parentOfArchive(archiveLocation('/home/j/a.tar.gz'), LINUX)).toEqual({
      kind: 'path',
      path: '/home/j',
    });
  });
});

describe('labelOfArchive', () => {
  it("the inner folder's name, or the archive's file name at its top", () => {
    expect(labelOfArchive(archiveLocation('C:\\x\\a.zip', 'docs/sub'))).toBe('sub');
    expect(labelOfArchive(archiveLocation('C:\\x\\a.zip'))).toBe('a.zip');
    expect(labelOfArchive(archiveLocation('/home/j/b.7z'))).toBe('b.7z');
  });
});

describe('crumbsOfArchive', () => {
  it("the archive's own crumbs, its file crumb going to the top, then one per inner folder", () => {
    const loc = archiveLocation('C:\\trove-test\\a.zip', 'docs/sub');
    const crumbs = crumbsOfArchive(loc, archivePathCrumbs(loc.archive));
    expect(crumbs.map((c) => c.label)).toEqual(['C:', 'trove-test', 'a.zip', 'docs', 'sub']);
    expect(crumbs[1].location).toEqual({ kind: 'path', path: 'C:\\trove-test' });
    expect(crumbs[2].location).toEqual(archiveLocation('C:\\trove-test\\a.zip'));
    expect(crumbs[3].location).toEqual(archiveLocation('C:\\trove-test\\a.zip', 'docs'));
    expect(crumbs[4].location).toEqual(loc);
    // keys stay unique and never collide with a real path
    expect(new Set(crumbs.map((c) => c.key)).size).toBe(crumbs.length);
    expect(isArchivePath(crumbs[4].key)).toBe(true);
  });
});

describe('archiveText / parseArchiveText', () => {
  it('shows the archive path then the inner folders in its own separator', () => {
    expect(archiveText(archiveLocation('C:\\x\\a.zip', 'docs/sub'))).toBe(
      'C:\\x\\a.zip\\docs\\sub',
    );
    expect(archiveText(archiveLocation('/home/j/a.tar.gz', 'docs'))).toBe('/home/j/a.tar.gz/docs');
    expect(archiveText(archiveLocation('C:\\x\\a.zip'))).toBe('C:\\x\\a.zip');
  });

  it('reads the shown text back', () => {
    for (const loc of [
      archiveLocation('C:\\x\\a.zip', 'docs/sub'),
      archiveLocation('/home/j/a.tar.gz', 'docs'),
    ])
      expect(parseArchiveText(archiveText(loc))).toEqual(loc);
  });

  it("the archive's own path is not a location (the address bar decides about the file)", () => {
    expect(parseArchiveText('C:\\x\\a.zip')).toBeNull();
    expect(parseArchiveText('C:\\x\\docs')).toBeNull();
    expect(parseArchiveText('/')).toBeNull();
  });

  it('a trailing separator after the name is the top: the new-window target round-trips', () => {
    expect(parseArchiveText('C:\\x\\a.zip\\')).toEqual(archiveLocation('C:\\x\\a.zip'));
    const top = archiveLocation('/home/j/a.7z');
    expect(archiveWindowTarget(top)).toBe('/home/j/a.7z/');
    expect(parseArchiveText(archiveWindowTarget(top))).toEqual(top);
    const inner = archiveLocation('C:\\x\\a.zip', 'docs');
    expect(parseArchiveText(archiveWindowTarget(inner))).toEqual(inner);
  });
});

describe('splitArchivePath', () => {
  it('splits a listing row path at its NUL; a real path gives null', () => {
    expect(splitArchivePath('C:\\x\\a.zip\u0000docs/a.txt')).toEqual({
      archive: 'C:\\x\\a.zip',
      inner: 'docs/a.txt',
    });
    expect(splitArchivePath('C:\\x\\a.zip')).toBeNull();
    expect(isArchivePath('C:\\x\\a.zip')).toBe(false);
  });
});

describe('a row inside an archive: its Location and its folder', () => {
  it('says where it is as the crumbs do, never the folder holding the zip', () => {
    // ⛔ parentOf('C:\x\a.zip\0b.txt') was 'C:\x' — what the Mac preview pane showed
    expect(archiveRowWhere('C:\\x\\a.zip\u0000b.txt')).toBe('a.zip');
    expect(archiveRowWhere('C:\\x\\a.zip\u0000docs/b.txt')).toBe('a.zip › docs');
    expect(archiveRowWhere('/home/j/a.tar.gz\u0000docs/sub/c')).toBe('a.tar.gz › docs › sub');
    expect(archiveRowWhere('C:\\x\\a.txt')).toBeNull();
  });

  it('Reveal goes to the inner folder that lists it', () => {
    expect(archiveRowFolder('C:\\x\\a.zip\u0000docs/b.txt')).toEqual(
      archiveLocation('C:\\x\\a.zip', 'docs'),
    );
    expect(archiveRowFolder('C:\\x\\a.zip\u0000b.txt')).toEqual(archiveLocation('C:\\x\\a.zip'));
    expect(archiveRowFolder('C:\\x\\a.txt')).toBeNull();
  });
});
