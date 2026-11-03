import { describe, expect, it, vi } from 'vitest';
import {
  INFOTIP_DELAY_MS,
  isSuppressed,
  placeTip,
  type InfotipBlockers,
} from './use-infotip.svelte';

// the hook reaches the list's state singletons; the IPC under them is not what is tested here
vi.mock('$lib/api/transfer', () => ({
  startTransfer: vi.fn(async () => 1),
  cancelTransfer: vi.fn(async () => {}),
  transferConflicts: vi.fn(async () => []),
  onTransferProgress: vi.fn(async () => () => {}),
  onTransferDone: vi.fn(async () => () => {}),
  dragOut: vi.fn(async () => ({ effect: 'none' })),
}));
vi.mock('$lib/api/clipboard', () => ({
  clipboardWritePaths: vi.fn(async () => {}),
  clipboardReadPaths: vi.fn(async () => null),
}));
vi.mock('$lib/api/fs', () => ({
  readDir: vi.fn(async (path: string) => ({ path, entries: [] })),
  trashEntries: vi.fn(async () => {}),
}));
vi.mock('$lib/api/shell', () => ({
  drives: vi.fn(async () => []),
  knownFolders: vi.fn(async () => []),
}));

const calm: InfotipBlockers = {
  dragging: false,
  banding: false,
  renaming: false,
  menuOpen: false,
};

describe('isSuppressed', () => {
  it('lets the tip through only when the list is idle', () => {
    expect(isSuppressed(calm)).toBe(false);
  });

  it('blocks on a drag, a rubber band, a rename box and an open menu — each alone', () => {
    const keys = ['dragging', 'banding', 'renaming', 'menuOpen'] as const;
    for (const key of keys) expect(isSuppressed({ ...calm, [key]: true })).toBe(true);
  });

  it("waits Windows' own tooltip dwell, 500 ms, before a card appears", () => {
    expect(INFOTIP_DELAY_MS).toBe(500);
  });
});

const view = { width: 1000, height: 800 };

describe('placeTip', () => {
  it('sits below-right of the pointer with room to spare', () => {
    expect(placeTip({ x: 100, y: 200 }, { width: 260, height: 120 }, view)).toEqual({
      x: 116,
      y: 216,
    });
  });

  it('pulls back from the right edge instead of running off it', () => {
    const p = placeTip({ x: 960, y: 200 }, { width: 260, height: 120 }, view);
    expect(p.x + 260).toBeLessThanOrEqual(view.width);
    expect(p.x).toBe(1000 - 8 - 260);
  });

  it('flips above the pointer near the bottom, so the card is never under the cursor', () => {
    const p = placeTip({ x: 100, y: 760 }, { width: 260, height: 120 }, view);
    expect(p.y).toBe(760 - 16 - 120);
    expect(p.y + 120).toBeLessThan(760);
  });

  it('stays on screen when the card is taller or wider than the viewport allows', () => {
    const p = placeTip({ x: 20, y: 30 }, { width: 2000, height: 2000 }, view);
    expect(p).toEqual({ x: 8, y: 8 });
  });
});
