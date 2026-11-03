import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ARCHIVE_PREVIEW_FAILED,
  ARCHIVE_PREVIEW_MAX_BYTES,
  ARCHIVE_TOO_BIG,
  preview,
} from './preview.svelte';
import { readTextHead } from '$lib/api/preview';
import { startOpenInner } from '$lib/api/archive';
import type { FileEntry } from '$lib/types/fs';

vi.mock('$lib/api/preview', () => ({
  readTextHead: vi.fn(),
  previewUrl: (p: string) => `http://preview.localhost/file/${encodeURIComponent(p)}`,
}));
vi.mock('$lib/api/archive', () => ({ startOpenInner: vi.fn() }));
vi.mock('$lib/api/log', () => ({ logError: vi.fn() }));

const entry = (name: string, ext: string | null): FileEntry => ({
  name,
  path: `C:\\x\\${name}`,
  isDir: false,
  size: 1,
  modifiedMs: null,
  createdMs: null,
  ext,
  isHidden: false,
  iconKey: `ext/${ext ?? ''}`,
  typeName: 'File',
});

const rows = [entry('a.png', 'png'), entry('b.txt', 'txt'), entry('c.md', 'md')];
const read = vi.mocked(readTextHead);

describe('preview state', () => {
  beforeEach(() => {
    read.mockReset();
    preview.sync(rows, new Set());
  });

  it('one image selected: kind image, no text fetch', () => {
    preview.sync(rows, new Set([rows[0].path]));
    expect(preview.entry?.name).toBe('a.png');
    expect(preview.kind).toBe('image');
    expect(preview.count).toBe(1);
    expect(read).not.toHaveBeenCalled();
  });

  it('one text file selected: the head is fetched and kept', async () => {
    read.mockResolvedValueOnce({ text: 'hello', truncated: false, binary: false });
    preview.sync(rows, new Set([rows[1].path]));
    expect(preview.kind).toBe('text');
    expect(preview.loading).toBe(true);
    await vi.waitFor(() => expect(preview.text?.text).toBe('hello'));
    expect(preview.loading).toBe(false);
    expect(read).toHaveBeenCalledWith(rows[1].path);
  });

  it('several selected: no entry, the count', () => {
    preview.sync(rows, new Set([rows[0].path, rows[1].path]));
    expect(preview.entry).toBeNull();
    expect(preview.count).toBe(2);
    expect(preview.kind).toBe('none');
  });

  it('a result for a file no longer selected is dropped', async () => {
    let resolveB: (h: { text: string; truncated: boolean; binary: boolean }) => void = () => {};
    read.mockImplementationOnce(() => new Promise((r) => (resolveB = r)));
    read.mockResolvedValueOnce({ text: 'from c', truncated: true, binary: false });
    preview.sync(rows, new Set([rows[1].path]));
    preview.sync(rows, new Set([rows[2].path]));
    resolveB({ text: 'from b', truncated: false, binary: false });
    await vi.waitFor(() => expect(preview.text?.text).toBe('from c'));
    expect(preview.entry?.name).toBe('c.md');
    expect(preview.text?.truncated).toBe(true);
  });

  it('re-syncing the same selection does not refetch', () => {
    read.mockResolvedValue({ text: 'x', truncated: false, binary: false });
    preview.sync(rows, new Set([rows[1].path]));
    preview.sync(rows, new Set([rows[1].path]));
    expect(read).toHaveBeenCalledTimes(1);
  });

  // ⛔ G.2 on Ubuntu: Copy with Replace wrote "NEWCOPY" over b.txt, Undo put the old file back
  // (sha256 checked), and the pane kept showing "NEWCOPY": same path, so sync returned early.
  it('the same file changed under its path (Replace, then Undo) is read again', async () => {
    read.mockResolvedValueOnce({ text: 'NEWCOPY', truncated: false, binary: false });
    const replaced = rows.map((r) => (r === rows[1] ? { ...r, size: 7, modifiedMs: 2000 } : r));
    preview.sync(replaced, new Set([rows[1].path]));
    await vi.waitFor(() => expect(preview.text?.text).toBe('NEWCOPY'));
    read.mockResolvedValueOnce({ text: 'old', truncated: false, binary: false });
    const undone = rows.map((r) => (r === rows[1] ? { ...r, size: 3, modifiedMs: 1000 } : r));
    preview.sync(undone, new Set([rows[1].path]));
    await vi.waitFor(() => expect(preview.text?.text).toBe('old'));
    expect(preview.entry?.size).toBe(3);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('a fresh listing with the file unchanged does not refetch', () => {
    read.mockResolvedValue({ text: 'x', truncated: false, binary: false });
    preview.sync(rows, new Set([rows[1].path]));
    preview.sync(
      rows.map((r) => ({ ...r })),
      new Set([rows[1].path]),
    );
    expect(read).toHaveBeenCalledTimes(1);
  });
});

describe('preview of a file inside an archive', () => {
  // `read_archive_dir` rows: `archive + "\0" + inner`. ⛔ Handed straight to read_text_head they
  // came back as the OS's "file name contained an unexpected NUL byte", shown as the preview.
  const zip = 'C:\\x\\a.zip';
  const inZip = (inner: string, ext: string | null, size = 10): FileEntry => ({
    ...entry(inner.split('/').at(-1) ?? inner, ext),
    path: `${zip}\u0000${inner}`,
    size,
  });
  const open = vi.mocked(startOpenInner);
  const notes = inZip('docs/notes.txt', 'txt');
  const photo = inZip('docs/a.png', 'png');
  const big = inZip('big.mp4', 'mp4', ARCHIVE_PREVIEW_MAX_BYTES + 1);
  const blob = inZip('data.bin', 'bin');
  const all = [notes, photo, big, blob];

  beforeEach(() => {
    read.mockReset();
    open.mockReset();
    preview.sync(all, new Set());
  });

  it('a text file is read from the temp copy, never by its NUL path', async () => {
    open.mockResolvedValueOnce('C:\\cache\\notes.txt');
    read.mockResolvedValueOnce({ text: 'hi', truncated: false, binary: false });
    preview.sync(all, new Set([notes.path]));
    await vi.waitFor(() => expect(preview.text?.text).toBe('hi'));
    expect(open).toHaveBeenCalledWith(zip, 'docs/notes.txt');
    expect(read).toHaveBeenCalledWith('C:\\cache\\notes.txt');
    expect(read).not.toHaveBeenCalledWith(notes.path);
    expect(preview.loading).toBe(false);
    expect(preview.error).toBeNull();
  });

  it('an image previews its temp copy', async () => {
    open.mockResolvedValueOnce('C:\\cache\\a.png');
    preview.sync(all, new Set([photo.path]));
    expect(preview.source).toBe('');
    await vi.waitFor(() => expect(preview.source).toBe('C:\\cache\\a.png'));
    expect(read).not.toHaveBeenCalled();
  });

  it('a failed extract is a plain sentence; the raw error stays out of the pane', async () => {
    open.mockRejectedValueOnce('zip: invalid Zip archive: bad CRC');
    preview.sync(all, new Set([notes.path]));
    await vi.waitFor(() => expect(preview.notice).toBe(ARCHIVE_PREVIEW_FAILED));
    expect(preview.error).toBeNull();
    expect(preview.loading).toBe(false);
    expect(read).not.toHaveBeenCalled();
  });

  it('a file too big to extract for a look gets a sentence, and nothing is extracted', () => {
    preview.sync(all, new Set([big.path]));
    expect(preview.notice).toBe(ARCHIVE_TOO_BIG);
    expect(open).not.toHaveBeenCalled();
  });

  it('a kind with no preview extracts nothing: the icon, as outside an archive', () => {
    preview.sync(all, new Set([blob.path]));
    expect(preview.kind).toBe('none');
    expect(open).not.toHaveBeenCalled();
    expect(preview.notice).toBeNull();
  });

  it('an extract that lands after the selection moved on is dropped', async () => {
    let land: (p: string) => void = () => {};
    open.mockImplementationOnce(() => new Promise((r) => (land = r)));
    preview.sync(all, new Set([photo.path]));
    preview.sync(all, new Set([blob.path]));
    land('C:\\cache\\a.png');
    await Promise.resolve();
    expect(preview.source).toBe('');
    expect(preview.entry?.name).toBe('data.bin');
  });
});
