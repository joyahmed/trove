import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SETTLE_MS, afterSettle } from './use-settled.svelte';

describe('afterSettle', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('fires once the delay has passed', () => {
    const fn = vi.fn();
    afterSettle(fn);
    vi.advanceTimersByTime(SETTLE_MS - 1);
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fn).toHaveBeenCalledOnce();
  });

  it('never fires when cancelled first (a tile unmounted before it settled)', () => {
    const fn = vi.fn();
    const cancel = afterSettle(fn);
    vi.advanceTimersByTime(SETTLE_MS - 10);
    cancel();
    vi.advanceTimersByTime(1000);
    expect(fn).not.toHaveBeenCalled();
  });
});
