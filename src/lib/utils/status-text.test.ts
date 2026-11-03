import { describe, expect, it } from 'vitest';
import type { FileEntry } from '$lib/types/fs';
import type { DriveInfo } from '$lib/types/shell';
import {
  driveHolding,
  filteredItemsText,
  freeSpaceText,
  selectionText,
} from '$lib/utils/status-text';

const linux = { os: 'linux', thisPcLabel: 'This Computer' };
const mac = { os: 'macos', thisPcLabel: 'This Mac' };
const GB = 1024 ** 3;

const entry = (path: string, size: number, isDir = false) => ({ path, size, isDir }) as FileEntry;
const drive = (path: string, label: string, freeBytes: number | null) =>
  ({ path, label, totalBytes: null, freeBytes }) as DriveInfo;

describe('selectionText', () => {
  const rows = [entry('/a', 1024 * 1024 * 4), entry('/b', 1024 * 1024 * 8), entry('/d', 0, true)];
  it('counts items when nothing is selected', () => {
    expect(selectionText(new Set(), rows, 48)).toBe('48 items');
    expect(selectionText(new Set(), rows, 1)).toBe('1 item');
  });
  it('one selected file shows its size', () => {
    expect(selectionText(new Set(['/a']), rows, 48)).toBe('1 of 48 selected · 4.0 MB');
  });
  it('several add up the files and skip folders', () => {
    expect(selectionText(new Set(['/a', '/b', '/d']), rows, 48)).toBe('3 of 48 selected · 12.0 MB');
  });
  it('folders only: no size', () => {
    expect(selectionText(new Set(['/d']), rows, 48)).toBe('1 of 48 selected');
  });
});

describe('driveHolding', () => {
  it('picks the longest prefix on Windows, ignoring case and slash direction', () => {
    const drives = [drive('C:\\', 'OS', 1), drive('G:\\', 'Data', 2)];
    expect(driveHolding('g:/06_tauri', drives)?.label).toBe('Data');
    expect(driveHolding('C:\\', drives)?.label).toBe('OS');
    expect(driveHolding('D:\\x', drives)).toBeNull();
  });
  it('picks the longest prefix on POSIX, not a sibling with the same start', () => {
    const drives = [
      drive('/', 'root', 1),
      drive('/mnt/data', 'data', 2),
      drive('/mnt/da', 'da', 3),
    ];
    expect(driveHolding('/mnt/data/x', drives, linux)?.label).toBe('data');
    expect(driveHolding('/mnt/data', drives, linux)?.label).toBe('data');
    expect(driveHolding('/mnt/database', drives, linux)?.label).toBe('root');
    expect(driveHolding('/home/alex', drives, linux)?.label).toBe('root');
  });
});

describe('freeSpaceText', () => {
  it('Windows names the drive letter', () => {
    expect(freeSpaceText('G:\\x', [drive('G:\\', 'Data', 412 * GB)])).toBe('412 GB free on G:');
  });
  it('macOS names the volume', () => {
    const drives = [drive('/Volumes/Backup', 'Backup', 50 * GB)];
    expect(freeSpaceText('/Volumes/Backup/a', drives, mac)).toBe('50.0 GB free on Backup');
  });
  it('Linux uses the label, else the path', () => {
    expect(freeSpaceText('/mnt/d/x', [drive('/mnt/d', 'Data', 5 * GB)], linux)).toBe(
      '5.00 GB free on Data',
    );
    expect(freeSpaceText('/mnt/d/x', [drive('/mnt/d', '', 5 * GB)], linux)).toBe(
      '5.00 GB free on /mnt/d',
    );
  });
  it('says nothing when free is unknown or no drive matches', () => {
    expect(freeSpaceText('G:\\x', [drive('G:\\', 'Data', null)])).toBe('');
    expect(freeSpaceText('Z:\\x', [drive('G:\\', 'Data', GB)])).toBe('');
  });
});

describe('freeSpaceText with the OS answer for the folder (Mac, disk image)', () => {
  const macDrives = [
    drive('/', 'Macintosh HD', 1600 * GB),
    drive('/Volumes/Backup', 'Backup', 50 * GB),
  ];
  const space = (mountRoot: string, freeBytes: number) => ({ mountRoot, freeBytes });
  it('a disk image the drive list leaves out names its own mount, not the boot disk', () => {
    const own = space('/Volumes/TroveTest', 2 * GB);
    expect(freeSpaceText('/Volumes/TroveTest/a', macDrives, mac, own)).toBe(
      '2.00 GB free on TroveTest',
    );
    // the old guess, without the answer, was the bug
    expect(freeSpaceText('/Volumes/TroveTest/a', macDrives, mac)).toBe(
      '1.56 TB free on Macintosh HD',
    );
  });
  it('a listed drive keeps its own name, with the free bytes the OS gave', () => {
    expect(freeSpaceText('/Users/alex', macDrives, mac, space('/', 1500 * GB))).toBe(
      '1.46 TB free on Macintosh HD',
    );
    expect(
      freeSpaceText('/Volumes/Backup/x', macDrives, mac, space('/Volumes/Backup', 40 * GB)),
    ).toBe('40.0 GB free on Backup');
  });
  it('a hidden Linux mount names its last part; the bare root is /', () => {
    expect(freeSpaceText('/srv/data/x', [], linux, space('/srv/data', 5 * GB))).toBe(
      '5.00 GB free on data',
    );
    expect(freeSpaceText('/x', [], linux, space('/', 5 * GB))).toBe('5.00 GB free on /');
  });
  it('Windows ignores it and keeps the drive letter', () => {
    const own = space('G:\\', GB);
    expect(freeSpaceText('G:\\x', [drive('G:\\', 'Data', 412 * GB)], undefined, own)).toBe(
      '412 GB free on G:',
    );
  });
  it('no answer falls back to the drive list', () => {
    expect(freeSpaceText('/Volumes/Backup/a', macDrives, mac, null)).toBe('50.0 GB free on Backup');
  });
});

describe('filteredItemsText', () => {
  it('is the plain count when nothing is hidden', () => {
    expect(filteredItemsText(56, 56)).toBe('56 items');
    expect(filteredItemsText(1, 1)).toBe('1 item');
  });
  it('says "N of M items" while a filter hides some', () => {
    expect(filteredItemsText(1, 56)).toBe('1 of 56 items');
    expect(filteredItemsText(0, 56)).toBe('0 of 56 items');
  });
});
