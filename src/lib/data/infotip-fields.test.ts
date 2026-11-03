import { describe, expect, it } from 'vitest';
import { infotipRowsFor } from './infotip-fields';
import type { FolderSize } from '$lib/hooks/use-infotip.svelte';
import type { FileEntry } from '$lib/types/fs';

const entry = (over: Partial<FileEntry> = {}): FileEntry => ({
  name: 'notes.txt',
  path: 'D:\\src\\notes.txt',
  isDir: false,
  size: 2048,
  modifiedMs: Date.UTC(2026, 0, 2, 3, 4),
  createdMs: Date.UTC(2025, 10, 30, 21, 5),
  ext: 'txt',
  isHidden: false,
  iconKey: 'ext/txt',
  typeName: 'Text Document',
  ...over,
});

const folder = entry({ isDir: true, name: 'src', typeName: 'File folder', size: 0 });

const labels = (e: FileEntry, f: FolderSize | null = null) =>
  infotipRowsFor(e, f).map((r) => r.label);
const sizeOf = (e: FileEntry, f: FolderSize | null) =>
  infotipRowsFor(e, f).find((r) => r.key === 'size')?.value;

describe('infotipRowsFor', () => {
  it('gives a file Type, Size, Date created and Date modified, in that order', () => {
    expect(labels(entry())).toEqual(['Type', 'Size', 'Date created', 'Date modified']);
    const size = infotipRowsFor(entry()).find((r) => r.key === 'size');
    expect(size?.value).toBe('2 KB');
  });

  it('drops Size for a folder with no walk running — the listing carries 0, not the truth', () => {
    const rows = labels(folder);
    expect(rows).toEqual(['Type', 'Date created', 'Date modified']);
    expect(rows).not.toContain('Size');
  });

  it('says Calculating… until the walk reports, then climbs, then settles', () => {
    expect(sizeOf(folder, { bytes: null, done: false, notCounted: 0, items: 0 })).toBe(
      'Calculating…',
    );
    expect(sizeOf(folder, { bytes: 3_500_000, done: false, notCounted: 0, items: 3 })).toBe(
      '3.3 MB…',
    );
    expect(sizeOf(folder, { bytes: 3_700_000, done: true, notCounted: 0, items: 3 })).toBe(
      '3.5 MB',
    );
    // the row is in Explorer's place, between Type and the dates, at every stage
    expect(
      infotipRowsFor(folder, { bytes: null, done: false, notCounted: 0, items: 0 }).map(
        (r) => r.label,
      ),
    ).toEqual(['Type', 'Size', 'Date created', 'Date modified']);
  });

  it('says what was not counted, and says so alone when nothing else was walked', () => {
    const w = (notCounted: number, items: number, done = true) =>
      sizeOf(folder, { bytes: 3_700_000, done, notCounted, items });
    expect(w(1, 3)).toBe('3.5 MB · size not counted for 1 folder');
    expect(w(2, 3)).toBe('3.5 MB · size not counted for 2 folders');
    expect(w(1, 0)).toBe('Size not counted');
    expect(w(1, 0, false)).toBe('3.5 MB… · size not counted for 1 folder');
  });

  it('a file ignores a walk entirely and shows its own size', () => {
    expect(sizeOf(entry(), { bytes: 999, done: false, notCounted: 0, items: 3 })).toBe('2 KB');
  });

  it('shows Size 0 B for an empty file, which is not the same as omitting it', () => {
    const rows = infotipRowsFor(entry({ size: 0 }));
    expect(rows.find((r) => r.key === 'size')?.value).toBe('0 B');
  });

  it('drops a date the filesystem does not carry', () => {
    expect(labels(entry({ createdMs: null }))).toEqual(['Type', 'Size', 'Date modified']);
    expect(labels(entry({ createdMs: null, modifiedMs: null }))).toEqual(['Type', 'Size']);
  });

  it('formats the dates with fmtDate, not a new formatter', () => {
    const created = infotipRowsFor(entry()).find((r) => r.key === 'created');
    // local time of the fixture's UTC instant, dd/MM/yyyy HH:mm
    const d = new Date(Date.UTC(2025, 10, 30, 21, 5));
    const two = (n: number) => String(n).padStart(2, '0');
    expect(created?.value).toBe(
      `${two(d.getDate())}/${two(d.getMonth() + 1)}/${d.getFullYear()} ${two(d.getHours())}:${two(d.getMinutes())}`,
    );
  });

  it('drops an empty type rather than rendering a blank row', () => {
    expect(labels(entry({ typeName: '' }))).toEqual(['Size', 'Date created', 'Date modified']);
  });
});
