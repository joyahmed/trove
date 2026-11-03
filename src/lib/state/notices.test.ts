import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_SHOWN, TIMEOUT_MS, notices } from './notices.svelte';

describe('notices', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    notices.clear();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows at most four, dropping the oldest', () => {
    for (let i = 1; i <= MAX_SHOWN + 2; i++) notices.push({ kind: 'info', message: `n${i}` });
    expect(notices.list.map((n) => n.message)).toEqual(['n3', 'n4', 'n5', 'n6']);
  });

  it('dismiss removes one by id and leaves the rest', () => {
    const a = notices.push({ kind: 'info', message: 'a' });
    notices.push({ kind: 'error', message: 'b' });
    notices.dismiss(a);
    expect(notices.list.map((n) => n.message)).toEqual(['b']);
  });

  it('auto-dismisses after the kind timeout', () => {
    notices.push({ kind: 'success', message: 'done' });
    notices.push({ kind: 'error', message: 'oops' });
    vi.advanceTimersByTime(TIMEOUT_MS.success);
    expect(notices.list.map((n) => n.message)).toEqual(['oops']);
    vi.advanceTimersByTime(TIMEOUT_MS.error - TIMEOUT_MS.success);
    expect(notices.list).toEqual([]);
  });

  it('pause holds the clock and resume runs the remainder', () => {
    const id = notices.push({ kind: 'info', message: 'hover me' });
    vi.advanceTimersByTime(2000);
    notices.pause(id);
    vi.advanceTimersByTime(60000);
    expect(notices.list).toHaveLength(1);
    notices.resume(id);
    vi.advanceTimersByTime(TIMEOUT_MS.info - 2000 - 1);
    expect(notices.list).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(notices.list).toHaveLength(0);
  });
});
