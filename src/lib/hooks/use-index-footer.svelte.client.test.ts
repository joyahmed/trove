// @vitest-environment ./vitest.svelte-client-env.ts
// The palette footer's index line (plan 21C.2a): "indexing D: — 412,000 so far" while a root is
// on its first walk, the count asked again every second, and nothing once every root is ready.
import { flushSync } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IndexFilling } from '$lib/api/palette';
import { indexProgress } from '$lib/state/index-progress.svelte';
import { INDEX_POLL_MS, useIndexFooter } from './use-index-footer.svelte';

const ask = vi.fn<() => Promise<IndexFilling[]>>(async () => []);
vi.mock('$lib/api/palette', () => ({ indexProgress: () => ask() }));
vi.mock('$lib/api/log', () => ({ logError: vi.fn() }));

const mount = () => {
  let footer!: ReturnType<typeof useIndexFooter>;
  const stop = $effect.root(() => {
    footer = useIndexFooter();
  });
  flushSync();
  return { footer, stop };
};

beforeEach(() => {
  vi.useFakeTimers();
  ask.mockReset();
  indexProgress.set([]);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('palette footer, index line', () => {
  it('says nothing when every root is indexed, and does not ask', () => {
    const { footer, stop } = mount();
    expect(footer.indexing).toBeNull();
    vi.advanceTimersByTime(INDEX_POLL_MS * 3);
    expect(ask).not.toHaveBeenCalled();
    stop();
  });

  it('shows the drive walking now and how many are queued behind it', () => {
    indexProgress.set([
      { label: 'D:', seen: 412000 },
      { label: 'E:', seen: 0 },
      { label: 'F:', seen: 0 },
    ]);
    const { footer, stop } = mount();
    expect(footer.indexing).toBe('indexing D: — 412,000 so far, 2 more after');
    stop();
  });

  it('climbs without a keystroke, then stops asking once the walk is done', async () => {
    indexProgress.set([{ label: 'D:', seen: 1000 }]);
    const { footer, stop } = mount();
    ask.mockResolvedValueOnce([{ label: 'D:', seen: 250000 }]);
    await vi.advanceTimersByTimeAsync(INDEX_POLL_MS);
    flushSync();
    expect(footer.indexing).toBe('indexing D: — 250,000 so far');

    ask.mockResolvedValueOnce([]);
    await vi.advanceTimersByTimeAsync(INDEX_POLL_MS);
    flushSync();
    expect(footer.indexing).toBeNull();
    const asked = ask.mock.calls.length;
    await vi.advanceTimersByTimeAsync(INDEX_POLL_MS * 3);
    expect(ask.mock.calls.length).toBe(asked);
    stop();
  });
});
