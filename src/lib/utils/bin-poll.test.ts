import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RecycleItem } from '$lib/types/recycle';
import { BIN_POLL_MS, sameListing, startBinPoll } from './bin-poll';

const item = (id: string, deletedMs = 1, name = `${id}.txt`): RecycleItem => ({
  id,
  name,
  originalParent: 'D:\\scratch',
  deletedMs,
  isDir: false,
  size: null,
});

describe('sameListing', () => {
  it('is true for the same ids, names and dates in the same order', () => {
    expect(sameListing([item('a'), item('b')], [item('a'), item('b')])).toBe(true);
    expect(sameListing([], [])).toBe(true);
  });

  it('is false when an item came, went, moved or changed', () => {
    expect(sameListing([item('a')], [item('a'), item('b')])).toBe(false);
    expect(sameListing([item('a'), item('b')], [item('b'), item('a')])).toBe(false);
    expect(sameListing([item('a', 1)], [item('a', 2)])).toBe(false);
    expect(sameListing([item('a', 1, 'x')], [item('a', 1, 'y')])).toBe(false);
  });
});

describe('startBinPoll', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('reads every BIN_POLL_MS until stopped', async () => {
    const read = vi.fn(async () => {});
    const stop = startBinPoll(read, { visible: () => true });
    expect(read).not.toHaveBeenCalled(); // entering the view already read it
    await vi.advanceTimersByTimeAsync(BIN_POLL_MS);
    expect(read).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(BIN_POLL_MS);
    expect(read).toHaveBeenCalledTimes(2);
    stop();
    await vi.advanceTimersByTimeAsync(BIN_POLL_MS * 5);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('never starts a read while the last one is still running', async () => {
    let finish = () => {};
    const read = vi.fn(() => new Promise<void>((r) => (finish = r)));
    const stop = startBinPoll(read, { visible: () => true });
    await vi.advanceTimersByTimeAsync(BIN_POLL_MS * 5);
    expect(read).toHaveBeenCalledTimes(1);
    finish();
    await vi.advanceTimersByTimeAsync(BIN_POLL_MS);
    expect(read).toHaveBeenCalledTimes(2);
    stop();
  });

  it('skips reads while the window is hidden', async () => {
    let shown = false;
    const read = vi.fn(async () => {});
    const stop = startBinPoll(read, { visible: () => shown });
    await vi.advanceTimersByTimeAsync(BIN_POLL_MS * 3);
    expect(read).not.toHaveBeenCalled();
    shown = true;
    await vi.advanceTimersByTimeAsync(BIN_POLL_MS);
    expect(read).toHaveBeenCalledTimes(1);
    stop();
  });

  it('keeps polling after a read throws', async () => {
    const read = vi.fn(async () => {
      throw new Error('nope');
    });
    const stop = startBinPoll(read, { visible: () => true });
    await vi.advanceTimersByTimeAsync(BIN_POLL_MS * 2);
    expect(read).toHaveBeenCalledTimes(2);
    stop();
  });

  it('a read that finishes after stop schedules nothing more', async () => {
    let finish = () => {};
    const read = vi.fn(() => new Promise<void>((r) => (finish = r)));
    const stop = startBinPoll(read, { visible: () => true });
    await vi.advanceTimersByTimeAsync(BIN_POLL_MS);
    stop();
    finish();
    await vi.advanceTimersByTimeAsync(BIN_POLL_MS * 5);
    expect(read).toHaveBeenCalledTimes(1);
  });
});
