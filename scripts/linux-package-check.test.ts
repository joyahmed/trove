import { expect, test } from 'bun:test';
import {
  compareVersions,
  maxGlibc,
  metainfoFiles,
  missingFields,
  notFound,
  parseArgs,
} from './linux-package-check';

test('compares versions as numbers, not text', () => {
  expect(compareVersions('2.9', '2.35')).toBe(-1);
  expect(compareVersions('2.39', '2.35')).toBe(1);
  expect(compareVersions('2.35', '2.35')).toBe(0);
  expect(compareVersions('2.3.4', '2.3')).toBe(1);
});

test('finds the highest GLIBC version in objdump -T output', () => {
  const dump = [
    '0000000000000000      DF *UND*  0000000000000000 (GLIBC_2.2.5) memcpy',
    '0000000000000000      DF *UND*  0000000000000000 (GLIBC_2.39) pidfd_spawnp',
    '0000000000000000      DF *UND*  0000000000000000 (GLIBC_2.34) __libc_start_main',
    '0000000000000000      DF *UND*  0000000000000000 (GLIBC_PRIVATE) _dl_x',
    '0000000000000000      DF *UND*  0000000000000000 (GCC_3.0) _Unwind_Resume',
  ].join('\n');
  expect(maxGlibc(dump)).toBe('2.39');
  expect(maxGlibc('no versions here')).toBeNull();
});

test('counts ldd lines that say not found', () => {
  const ldd = '\tlibgtk-3.so.0 => /lib/libgtk-3.so.0 (0x1)\n\tlibfoo.so.1 => not found\n';
  expect(notFound(ldd)).toEqual(['libfoo.so.1 => not found']);
  expect(notFound('\tlibc.so.6 => /lib/libc.so.6 (0x1)\n')).toEqual([]);
});

test('names the control fields that are absent or empty', () => {
  const control = 'Package: trove\nVersion: 0.1.0\nArchitecture: amd64\nDepends:\nDescription: x\n';
  expect(missingFields(control)).toEqual(['Depends']);
  expect(missingFields('Package: trove\n', ['Package', 'Version'])).toEqual(['Version']);
});

test('lists metainfo files, not the folder', () => {
  const listing = [
    'drwxr-xr-x root/root  0 2026-10-23 10:00 ./usr/share/metainfo/',
    '-rw-r--r-- root/root 99 2026-10-23 10:00 ./usr/share/metainfo/com.joyahmed.trove.metainfo.xml',
    '-rwxr-xr-x root/root 99 2026-10-23 10:00 ./usr/bin/trove',
  ].join('\n');
  expect(metainfoFiles(listing)).toEqual(['./usr/share/metainfo/com.joyahmed.trove.metainfo.xml']);
  // dpkg-deb from tauri's bundler prints paths without the leading "./".
  const bare =
    '-rw-r--r-- 0/0 1522 2026-10-23 18:25 usr/share/metainfo/com.joyahmed.trove.metainfo.xml';
  expect(metainfoFiles(bare)).toEqual(['usr/share/metainfo/com.joyahmed.trove.metainfo.xml']);
  expect(metainfoFiles('drwxr-xr-x 0/0 0 2026-10-23 18:25 usr/share/metainfo')).toEqual([]);
});

test('reads the file and --max, refuses bad input', () => {
  expect(parseArgs(['a.deb'])).toEqual({ file: 'a.deb', max: '2.35' });
  expect(parseArgs(['--max', '2.39', 'a.deb'])).toEqual({ file: 'a.deb', max: '2.39' });
  expect(parseArgs([])).toBeNull();
  expect(parseArgs(['a.deb', '--max'])).toBeNull();
  expect(parseArgs(['a.deb', 'b.deb'])).toBeNull();
});
