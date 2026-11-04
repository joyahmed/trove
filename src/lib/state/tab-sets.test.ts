import { beforeEach, describe, expect, it, vi } from 'vitest';

const openTabsHere = vi.fn(async () => {});
vi.mock('$lib/state/tab-restore', () => ({ openTabsHere }));
vi.mock('$lib/state/actions.svelte', () => ({ actions: { notify: vi.fn() } }));
const { pathLocation } = await import('$lib/utils/location');

const tab = (p: string) => ({ location: pathLocation(p) });
const list = [tab('/a'), tab('/b'), tab('/c')];
const tabsMock = {
  list: [...list],
  activeIndex: 1,
  close: vi.fn((i: number) => void tabsMock.list.splice(i, 1)),
};
vi.mock('$lib/state/tabs.svelte', () => ({ tabs: tabsMock }));

const { settings } = await import('$lib/state/settings.svelte');
const { confirm } = await import('$lib/state/confirm.svelte');
const { tabSets } = await import('./tab-sets.svelte');
const { runPaletteAction } = await import('$lib/data/palette-action-runners');

/** type `text` into the open name box and press OK */
const typeAndOk = async (text: string) => {
  await Promise.resolve();
  confirm.text = text;
  confirm.answer(true);
};
const settle = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  settings.tabSets = [];
  tabsMock.list = [...list];
  tabsMock.activeIndex = 1;
  openTabsHere.mockClear();
});

describe('tab sets', () => {
  it('save then open round-trips through openTabsHere', async () => {
    const saving = tabSets.saveAs();
    await typeAndOk('Work');
    await saving;
    expect(settings.tabSets).toHaveLength(1);
    expect(settings.tabSets[0]).toMatchObject({
      name: 'Work',
      tabs: ['/a', '/b', '/c'],
      active: 1,
    });
    await tabSets.open('work');
    expect(tabsMock.list).toHaveLength(1);
    expect(openTabsHere).toHaveBeenCalledWith({ tabs: ['/a', '/b', '/c'], active: 1 });
  });

  it('an empty name stays open with a problem; cancel saves nothing', async () => {
    const saving = tabSets.saveAs();
    await typeAndOk('  ');
    expect(confirm.pending).not.toBeNull();
    expect(confirm.problem).not.toBeNull();
    confirm.answer(false);
    await saving;
    expect(settings.tabSets).toHaveLength(0);
  });

  it('the same name asks before replacing; no keeps the old set', async () => {
    const first = tabSets.saveAs();
    await typeAndOk('Work');
    await first;
    tabsMock.list = [tab('/z')];
    const again = tabSets.saveAs();
    await typeAndOk('WORK');
    await settle();
    expect(confirm.pending?.title).toBe('Replace tab set?');
    confirm.answer(false);
    await again;
    expect(settings.tabSets[0]?.tabs).toEqual(['/a', '/b', '/c']);

    const third = tabSets.saveAs();
    await typeAndOk('work');
    await settle();
    confirm.answer(true);
    await third;
    expect(settings.tabSets).toHaveLength(1);
    expect(settings.tabSets[0]).toMatchObject({ name: 'Work', tabs: ['/z'] });
  });

  it('renames, and refuses a name another set has', async () => {
    settings.tabSets = [
      { name: 'A', tabs: ['/a'], active: 0, savedAt: 1 },
      { name: 'B', tabs: ['/b'], active: 0, savedAt: 1 },
    ];
    const r = tabSets.rename('A');
    await Promise.resolve();
    expect(confirm.text).toBe('A');
    confirm.text = 'b';
    confirm.answer(true);
    expect(confirm.problem).toBe('A tab set has that name already');
    confirm.text = 'C';
    confirm.answer(true);
    await r;
    expect(settings.tabSets.map((s) => s.name)).toEqual(['C', 'B']);
  });

  it('delete asks first', async () => {
    settings.tabSets = [{ name: 'A', tabs: ['/a'], active: 0, savedAt: 1 }];
    const d = tabSets.remove('A');
    expect(confirm.pending?.danger).toBe(true);
    confirm.answer(false);
    await d;
    expect(settings.tabSets).toHaveLength(1);
    const e = tabSets.remove('A');
    confirm.answer(true);
    await e;
    expect(settings.tabSets).toHaveLength(0);
  });

  it('the palette keys reach the same calls', async () => {
    settings.tabSets = [{ name: 'A: b', tabs: ['/a'], active: 0, savedAt: 1 }];
    await runPaletteAction('tab-set-open:A: b');
    expect(openTabsHere).toHaveBeenCalledWith({ tabs: ['/a'], active: 0 });
  });
});
