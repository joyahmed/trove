import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RecycleItem } from '$lib/types/recycle';

const api = vi.hoisted(() => ({
  items: [] as RecycleItem[],
  recycleList: vi.fn(async () => api.items),
  recycleRestore: vi.fn(async () => {}),
  recyclePurge: vi.fn(async () => {}),
  recycleEmpty: vi.fn(async () => {}),
  openInExplorer: vi.fn(async () => {}),
}));
vi.mock('$lib/api/recycle', () => api);

import { recycle } from './recycle.svelte';

const item = (id: string, deletedMs: number): RecycleItem => ({
  id,
  name: `${id}.txt`,
  originalParent: 'D:\\scratch',
  deletedMs,
  isDir: false,
  size: null,
});

describe('recycle bin state', () => {
  beforeEach(() => {
    api.items = [item('new', 30), item('old', 10), item('mid', 20)];
    api.recycleList.mockClear();
    api.recycleRestore.mockClear();
    api.recyclePurge.mockClear();
    api.recycleEmpty.mockClear();
    recycle.loaded = false;
    recycle.items = [];
    recycle.error = null;
    recycle.loading = false;
    recycle.clearSelection();
  });

  it('lists what Rust gives (already newest first)', async () => {
    await recycle.load();
    expect(api.recycleList).toHaveBeenCalledTimes(1);
    expect(recycle.items.map((i) => i.id)).toEqual(['new', 'old', 'mid']);
    expect(recycle.count).toBe(3);
  });

  it('reads the bin again on every entry, so the list is not stale', async () => {
    await recycle.load();
    api.items = [item('new', 30)];
    await recycle.load();
    expect(api.recycleList).toHaveBeenCalledTimes(2);
    expect(recycle.items.map((i) => i.id)).toEqual(['new']);
  });

  it('picks up items after a first visit found the bin empty', async () => {
    // the regression: count stayed 0 and the header's Empty / Restore all stayed disabled
    api.items = [];
    await recycle.load();
    expect(recycle.count).toBe(0);
    api.items = [item('new', 30), item('old', 10)];
    await recycle.load();
    expect(recycle.count).toBe(2);
  });

  it('raises loading on the first read and never again — a re-entry does not flicker', async () => {
    const seen: boolean[] = [];
    api.recycleList.mockImplementation(async () => {
      seen.push(recycle.loading);
      return api.items;
    });
    await recycle.load();
    await recycle.load();
    expect(seen).toEqual([true, false]);
    expect(recycle.loading).toBe(false);
    api.recycleList.mockImplementation(async () => api.items);
  });

  it('keeps the rows on screen when a silent re-read fails', async () => {
    await recycle.load();
    api.recycleList.mockRejectedValueOnce(new Error('bin gone'));
    await recycle.load();
    expect(recycle.items.map((i) => i.id)).toEqual(['new', 'old', 'mid']);
    expect(recycle.error).toContain('bin gone');
    expect(recycle.loading).toBe(false);
  });

  it('restore hands the ids to Rust, re-lists, and drops a selection that is gone', async () => {
    await recycle.load();
    recycle.select('old');
    api.items = [item('new', 30), item('mid', 20)];
    await recycle.restore(['old']);
    expect(api.recycleRestore).toHaveBeenCalledWith(['old']);
    expect(api.recycleList).toHaveBeenCalledTimes(2);
    expect(recycle.count).toBe(2);
    expect(recycle.isSelected('old')).toBe(false);
  });

  it('empty purges everything; a failure lands in error and still re-lists', async () => {
    await recycle.load();
    api.items = [];
    await recycle.empty();
    expect(api.recycleEmpty).toHaveBeenCalledTimes(1);
    expect(recycle.count).toBe(0);
    api.recyclePurge.mockRejectedValueOnce(new Error('locked'));
    await recycle.purge(['new']);
    expect(recycle.error).toContain('locked');
    expect(api.recycleList).toHaveBeenCalledTimes(3);
  });

  it('countNow re-reads the bin, so a confirmation is built on the count now', async () => {
    await recycle.load();
    expect(recycle.count).toBe(3);
    // the bin grows while the view is away — a delete from anywhere else in the app
    api.items = [...api.items, item('later', 40)];
    expect(await recycle.countNow()).toBe(4);
    expect(api.recycleList).toHaveBeenCalledTimes(2);
  });

  it('a read that has been superseded does not overwrite the newer one', async () => {
    await recycle.load();
    let releaseSlow: () => void = () => {};
    api.recycleList
      // the first read is slow and answers with the bin as it was
      .mockImplementationOnce(
        () =>
          new Promise<RecycleItem[]>((resolve) => {
            releaseSlow = () => resolve([item('stale', 1)]);
          }),
      )
      // the second is started after it and answers first, with the bin as it is
      .mockImplementationOnce(async () => [item('now', 2)]);

    const slow = recycle.reload();
    await recycle.reload();
    expect(recycle.items.map((i) => i.id)).toEqual(['now']);

    releaseSlow();
    await slow;
    expect(recycle.items.map((i) => i.id)).toEqual(['now']);
    expect(recycle.loading).toBe(false);
  });

  it('an operation that skipped items keeps saying so through a refresh already in flight', async () => {
    // the regression: purge fails on locked items, the message is set after the re-list — and a
    // refresh started while that re-list was open (F5, a re-entry) answered last and, being the
    // newer read, was entitled to clear the error. Rust logged the failure; the person was told
    // nothing.
    await recycle.load();

    let releaseRelist: () => void = () => {};
    let releaseRefresh: () => void = () => {};
    api.recyclePurge.mockRejectedValueOnce(new Error('Could not delete 2 items'));
    api.recycleList
      // the re-list `#run` does itself — held open so a refresh can start behind it
      .mockImplementationOnce(
        () =>
          new Promise<RecycleItem[]>((resolve) => {
            releaseRelist = () => resolve([item('new', 30)]);
          }),
      )
      // the refresh that was already in flight, answering after the error is set
      .mockImplementationOnce(
        () =>
          new Promise<RecycleItem[]>((resolve) => {
            releaseRefresh = () => resolve([item('new', 30)]);
          }),
      );

    const op = recycle.purge(['old']);
    await vi.waitFor(() => expect(api.recycleList).toHaveBeenCalledTimes(2));
    const refresh = recycle.reload();
    await vi.waitFor(() => expect(api.recycleList).toHaveBeenCalledTimes(3));

    releaseRelist();
    await op;
    expect(recycle.error).toContain('Could not delete 2 items');

    releaseRefresh();
    await refresh;
    expect(recycle.error).toContain('Could not delete 2 items');
    expect(recycle.items.map((i) => i.id)).toEqual(['new']);
    expect(recycle.loading).toBe(false);
  });

  it('a refresh started after the error is told about it clears it', async () => {
    await recycle.load();
    api.recyclePurge.mockRejectedValueOnce(new Error('locked'));
    await recycle.purge(['old']);
    expect(recycle.error).toContain('locked');
    await recycle.reload();
    expect(recycle.error).toBe(null);
  });

  it('poll picks up an item binned from outside, keeps the selection, raises nothing', async () => {
    await recycle.load();
    recycle.select('old');
    api.items = [item('outside', 40), ...api.items];
    const loading: boolean[] = [];
    const p = recycle.poll();
    loading.push(recycle.loading);
    await p;
    expect(loading).toEqual([false]);
    expect(recycle.items.map((i) => i.id)).toEqual(['outside', 'new', 'old', 'mid']);
    expect(recycle.isSelected('old')).toBe(true);
  });

  it('poll leaves the same array in place when nothing changed', async () => {
    await recycle.load();
    const before = recycle.items;
    api.items = [...api.items.map((i) => ({ ...i }))];
    await recycle.poll();
    expect(recycle.items).toBe(before);
  });

  it("poll neither clears an operation's error nor reports its own failure", async () => {
    await recycle.load();
    api.recyclePurge.mockRejectedValueOnce(new Error('locked'));
    await recycle.purge(['old']);
    await recycle.poll();
    expect(recycle.error).toContain('locked');
    recycle.error = null;
    api.recycleList.mockRejectedValueOnce(new Error('bin gone'));
    await recycle.poll();
    expect(recycle.error).toBe(null);
    expect(recycle.items.length).toBe(3);
  });

  it('poll does nothing before the first read', async () => {
    await recycle.poll();
    expect(api.recycleList).not.toHaveBeenCalled();
  });

  it('a poll overtaken by F5 writes nothing', async () => {
    await recycle.load();
    let release: (items: RecycleItem[]) => void = () => {};
    api.recycleList.mockImplementationOnce(() => new Promise((r) => (release = r)));
    const slow = recycle.poll();
    api.items = [item('new', 30)];
    await recycle.reload();
    release([item('stale', 1)]);
    await slow;
    expect(recycle.items.map((i) => i.id)).toEqual(['new']);
  });
});
