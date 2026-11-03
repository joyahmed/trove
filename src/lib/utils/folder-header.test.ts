import { describe, expect, it } from 'vitest';
import type { FileEntry } from '$lib/types/fs';
import { folderMeta, itemsText } from './folder-header';

const entry = (isDir: boolean, size: number) => ({ isDir, size }) as FileEntry;

describe('folder header text', () => {
  it('pluralises items', () => {
    expect(itemsText(1)).toBe('1 item');
    expect(itemsText(0)).toBe('0 items');
    expect(itemsText(2)).toBe('2 items');
  });

  it('sizes a folder that holds only files', () => {
    const rows = [entry(false, 1024 * 1024), entry(false, 1024 * 1024)];
    expect(folderMeta('C:\\Users\\alex', rows)).toBe('C:\\Users\\alex · 2 items · 2.0 MB');
  });

  it('leaves the size out once a subfolder is there: its bytes are not in the listing', () => {
    // the Mac: /System/Applications, 48 .app folders and a 0-byte file, said "49 items · 0 B"
    // while the Details pane counted 1.2 GB
    const rows = [entry(true, 0), entry(false, 1024 * 1024), entry(false, 0)];
    expect(folderMeta('C:\\Users\\alex', rows)).toBe('C:\\Users\\alex · 3 items');
    expect(folderMeta('/System/Applications', [entry(true, 0), entry(false, 0)])).toBe(
      '/System/Applications · 2 items',
    );
  });

  it('leaves the size out when there are no files', () => {
    expect(folderMeta('/home/alex', [entry(true, 0)])).toBe('/home/alex · 1 item');
    expect(folderMeta('/home/alex', [])).toBe('/home/alex · 0 items');
  });
});
