// The bin's "Empty" button follows the "I'm coming from" style live (plan 19, 1.4): switching
// the style while the bin is open renames the button without leaving the bin.
import { flushSync } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { comingFrom, type ComingFrom } from '$lib/state/coming-from.svelte';
import { confirm } from '$lib/state/confirm.svelte';
import { recycle } from '$lib/state/recycle.svelte';
import { useRecycleView } from './use-recycle-view.svelte';

// No real bin: the view's entry read goes to a stub that touches nothing.
vi.mock('$lib/state/recycle.svelte', () => ({
  recycle: {
    items: [],
    selected: new Set(),
    count: 0,
    loading: false,
    error: null,
    load: vi.fn(async () => {}),
    countNow: vi.fn(async () => 0),
    empty: vi.fn(async () => {}),
    restore: vi.fn(async () => {}),
    purge: vi.fn(async () => {}),
    isSelected: () => false,
  },
}));

afterEach(() => {
  comingFrom.choice = 'native';
  recycle.selected.clear();
  vi.restoreAllMocks();
  vi.mocked(recycle.purge).mockClear();
});

const emptyLabel = (view: ReturnType<typeof useRecycleView>) =>
  view.headerActions.find((a) => a.key === 'empty')?.label;

describe('useRecycleView header actions', () => {
  it('renames the Empty button when the style changes while the bin is open', () => {
    comingFrom.choice = 'windows';
    let view!: ReturnType<typeof useRecycleView>;
    const stop = $effect.root(() => {
      view = useRecycleView();
    });
    flushSync();
    expect(emptyLabel(view)).toBe('Empty Recycle Bin');

    comingFrom.choice = 'mac';
    flushSync();
    expect(emptyLabel(view)).toBe('Empty Trash');

    comingFrom.choice = 'windows';
    flushSync();
    expect(emptyLabel(view)).toBe('Empty Recycle Bin');
    stop();
  });
});

const key = (k: string, mods: Partial<KeyboardEventInit> = {}) => {
  const e = {
    key: k,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    ...mods,
    preventDefault() {},
    stopPropagation() {},
    getModifierState: () => false,
  };
  return e as unknown as KeyboardEvent;
};

// Plan 19, 2.3.3: every purge key asks first, whatever the style. Nothing injected → Windows host.
describe('useRecycleView purge keys', () => {
  const styles: ComingFrom[] = ['windows', 'mac', 'linux'];
  const purgeKeys = (style: ComingFrom) =>
    style === 'mac'
      ? [key('Delete'), key('Backspace', { ctrlKey: true, altKey: true })]
      : [key('Delete')];

  for (const style of styles) {
    it(`asks before purging under ${style} style, and purges nothing on Cancel`, async () => {
      comingFrom.choice = style;
      recycle.selected.add('item-1');
      let view!: ReturnType<typeof useRecycleView>;
      const stop = $effect.root(() => {
        view = useRecycleView();
      });
      flushSync();
      for (const e of purgeKeys(style)) {
        const ask = vi.spyOn(confirm, 'ask').mockResolvedValue(false);
        view.onkeydown(e);
        await Promise.resolve();
        expect(ask).toHaveBeenCalledTimes(1);
        expect(recycle.purge).not.toHaveBeenCalled();

        ask.mockResolvedValue(true);
        view.onkeydown(key(e.key, { ctrlKey: e.ctrlKey, altKey: e.altKey }));
        await vi.waitFor(() => expect(recycle.purge).toHaveBeenCalledWith(['item-1']));
        vi.mocked(recycle.purge).mockClear();
        ask.mockRestore();
      }
      stop();
    });
  }

  it('ignores Ctrl+Alt+Backspace outside Mac style (no question, no purge)', () => {
    comingFrom.choice = 'windows';
    recycle.selected.add('item-1');
    let view!: ReturnType<typeof useRecycleView>;
    const stop = $effect.root(() => {
      view = useRecycleView();
    });
    flushSync();
    const ask = vi.spyOn(confirm, 'ask').mockResolvedValue(true);
    view.onkeydown(key('Backspace', { ctrlKey: true, altKey: true }));
    expect(ask).not.toHaveBeenCalled();
    expect(recycle.purge).not.toHaveBeenCalled();
    stop();
  });
});

describe('useRecycleView purge title', () => {
  it.each([
    [[{ id: 'd', isDir: true }], ['d'], 'Delete Folder'],
    [[{ id: 'f', isDir: false }], ['f'], 'Delete File'],
    [
      [
        { id: 'a', isDir: true },
        { id: 'b', isDir: false },
      ],
      ['a', 'b'],
      'Delete Multiple Items',
    ],
  ])('%j selected: %s -> %s', async (items, selected, title) => {
    (recycle as { items: unknown[] }).items = items;
    for (const id of selected) recycle.selected.add(id);
    let view!: ReturnType<typeof useRecycleView>;
    const stop = $effect.root(() => {
      view = useRecycleView();
    });
    flushSync();
    const ask = vi.spyOn(confirm, 'ask').mockResolvedValue(false);
    view.onkeydown(key('Delete'));
    await Promise.resolve();
    expect(ask).toHaveBeenCalledWith(expect.objectContaining({ title }));
    (recycle as { items: unknown[] }).items = [];
    stop();
  });
});
