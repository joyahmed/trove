import { describe, expect, it } from 'vitest';
import {
  APPLICATIONS,
  GALLERY,
  HOME,
  RECYCLE_BIN,
  THIS_PC,
  pathLocation,
  tabToken,
} from './location';
import {
  pathIsNative,
  planRestore,
  resolveRestoredTab,
  tabsToRestore,
  windowTabsOf,
} from './restore-tabs';

describe('tabsToRestore', () => {
  it('reopens the remembered folders when the launch asked for nothing', () => {
    expect(tabsToRestore(null, { restoreTabs: true, openTabs: ['C:\\a', 'D:\\b'] })).toEqual([
      'C:\\a',
      'D:\\b',
    ]);
  });

  it('a launch with a path wins over the remembered tabs', () => {
    expect(tabsToRestore('C:\\x', { restoreTabs: true, openTabs: ['C:\\a'] })).toEqual([]);
  });

  it('the setting off, or nothing remembered, restores nothing', () => {
    expect(tabsToRestore(null, { restoreTabs: false, openTabs: ['C:\\a'] })).toEqual([]);
    expect(tabsToRestore(null, { restoreTabs: true, openTabs: ['', ''] })).toEqual([]);
  });
});

describe('windowTabsOf (what each window reports)', () => {
  it('drops the tabs with no token (an archive, an empty tab), the active index kept', () => {
    // archive, C:\a, archive, D:\b (active)
    expect(windowTabsOf(['', 'C:\\a', '', 'D:\\b'], 3, 20)).toEqual({
      tabs: ['C:\\a', 'D:\\b'],
      active: 1,
    });
    // the active tab is not saved: the first saved tab
    expect(windowTabsOf(['C:\\a', ''], 1, 20)).toEqual({ tabs: ['C:\\a'], active: 0 });
    expect(windowTabsOf([''], 0, 20)).toEqual({ tabs: [], active: 0 });
  });

  it('keeps at most `max` tabs, the active index inside them', () => {
    expect(windowTabsOf(['a', 'b', 'c'], 2, 2)).toEqual({ tabs: ['a', 'b'], active: 0 });
  });
});

describe('planRestore (what the next start reopens)', () => {
  const on = { restoreTabs: true, openTabs: ['C:\\stale'] };

  it('two windows round-trip: main gets the first, the other opens with its own tabs', () => {
    // what each window of the last run reported, as Rust handed it back (main first)
    const main = windowTabsOf(['C:\\a', 'C:\\b'], 1, 20);
    const second = windowTabsOf(['D:\\x', '', 'D:\\y', 'D:\\z'], 2, 20);
    const plan = planRestore(null, on, {
      windows: [
        { label: 'main', ...main },
        { label: 'main-2', ...second },
      ],
    });
    expect(plan.main).toEqual({ tabs: ['C:\\a', 'C:\\b'], active: 1 });
    expect(plan.others).toEqual([{ tabs: ['D:\\x', 'D:\\y', 'D:\\z'], active: 1 }]);
  });

  it('a window closed before quit (absent from the session) does not come back', () => {
    // Rust forgot main-2 when it was closed on its own; only main-3 was left beside main
    const plan = planRestore(null, on, {
      windows: [
        { label: 'main', tabs: ['C:\\a'], active: 0 },
        { label: 'main-3', tabs: ['E:\\z'], active: 0 },
      ],
    });
    expect(plan.others).toEqual([{ tabs: ['E:\\z'], active: 0 }]);
  });

  it('main closed first: the window left open at quit becomes main', () => {
    const plan = planRestore(null, on, {
      windows: [{ label: 'main-2', tabs: ['D:\\x', 'D:\\y'], active: 1 }],
    });
    expect(plan).toEqual({ main: { tabs: ['D:\\x', 'D:\\y'], active: 1 }, others: [] });
  });

  it('one window: exactly its tabs, nothing else opens', () => {
    const plan = planRestore(null, on, {
      windows: [{ label: 'main', tabs: ['C:\\a', 'D:\\b'], active: 0 }],
    });
    expect(plan).toEqual({ main: { tabs: ['C:\\a', 'D:\\b'], active: 0 }, others: [] });
  });

  it('a Dock rebuild (the window closed last, handed back by Rust): its active tab, not the first', () => {
    // a Mac: main on its third tab closed last, the app kept in the Dock, then a Dock click
    const plan = planRestore(null, on, {
      windows: [{ label: 'main', tabs: ['C:\\a', 'C:\\b', 'C:\\c'], active: 2 }],
    });
    expect(plan).toEqual({ main: { tabs: ['C:\\a', 'C:\\b', 'C:\\c'], active: 2 }, others: [] });
  });

  it('no session file (an older build): main alone, from openTabs, first tab active — as before', () => {
    const s = { restoreTabs: true, openTabs: ['C:\\a', '', 'D:\\b'] };
    expect(planRestore(null, s, null)).toEqual({
      main: { tabs: tabsToRestore(null, s), active: 0 },
      others: [],
    });
  });

  it('the setting off restores nothing; a launch with a path keeps main, others return', () => {
    const last = {
      windows: [
        { label: 'main', tabs: ['C:\\a'], active: 0 },
        { label: 'main-2', tabs: ['D:\\x'], active: 0 },
      ],
    };
    const nothing = { main: { tabs: [], active: 0 }, others: [] };
    expect(planRestore(null, { ...on, restoreTabs: false }, last)).toEqual(nothing);
    // the session was handed to this run: windows it does not reopen are gone for good
    expect(planRestore('C:\\launch', on, last)).toEqual({
      main: { tabs: [], active: 0 },
      others: [{ tabs: ['D:\\x'], active: 0 }],
    });
  });

  it('a damaged entry cannot break the start: bad active, blank tabs', () => {
    const plan = planRestore(null, on, {
      windows: [{ label: 'main', tabs: ['', 'C:\\a'], active: 7 }],
    });
    expect(plan.main).toEqual({ tabs: ['C:\\a'], active: 0 });
  });
});

describe('place tabs come back (plan 15 G.45)', () => {
  const on = { restoreTabs: true, openTabs: [] };
  const home = tabToken(HOME);
  const thisPc = tabToken(THIS_PC);

  it('[Home, C:\\a, This PC] with This PC active round-trips with active=2', () => {
    const saved = windowTabsOf([HOME, pathLocation('C:\\a'), THIS_PC].map(tabToken), 2, 20);
    expect(saved).toEqual({ tabs: [home, 'C:\\a', thisPc], active: 2 });
    const plan = planRestore(null, on, { windows: [{ label: 'main', ...saved }] });
    expect(plan.main).toEqual({ tabs: [home, 'C:\\a', thisPc], active: 2 });
  });

  it('Gallery, Applications and the bin are saved too', () => {
    const tokens = [GALLERY, APPLICATIONS, RECYCLE_BIN].map(tabToken);
    expect(windowTabsOf(tokens, 1, 20)).toEqual({ tabs: tokens, active: 1 });
  });

  it('an old paths-only session still loads', () => {
    const plan = planRestore(null, on, {
      windows: [{ label: 'main', tabs: ['C:\\a', 'D:\\b'], active: 1 }],
    });
    expect(plan.main).toEqual({ tabs: ['C:\\a', 'D:\\b'], active: 1 });
  });

  it('an unknown trove: token is skipped, the active tab followed past it', () => {
    const plan = planRestore(null, on, {
      windows: [{ label: 'main', tabs: ['trove:x', 'C:\\a', home], active: 2 }],
    });
    expect(plan.main).toEqual({ tabs: ['C:\\a', home], active: 1 });
  });

  it('"Restore tabs" off still restores nothing', () => {
    const plan = planRestore(
      null,
      { ...on, restoreTabs: false },
      {
        windows: [{ label: 'main', tabs: [home, 'C:\\a', thisPc], active: 2 }],
      },
    );
    expect(plan).toEqual({ main: { tabs: [], active: 0 }, others: [] });
  });
});

describe('resolveRestoredTab (a restored tab from another OS or gone opens Home)', () => {
  const deps = (windows: boolean, there: string[] = []) => ({
    windows,
    exists: async (p: string) => there.includes(p),
    fallback: HOME,
  });

  it('a Windows path on a Mac or Linux opens Home', async () => {
    expect(await resolveRestoredTab('C:\\Users\\a', deps(false, ['C:\\Users\\a']))).toEqual(HOME);
    expect(await resolveRestoredTab('\\\\host\\share', deps(false))).toEqual(HOME);
  });

  it('a unix path on Windows opens Home', async () => {
    expect(await resolveRestoredTab('/Users/a', deps(true, ['/Users/a']))).toEqual(HOME);
    expect(await resolveRestoredTab('/home/a', deps(true, ['/home/a']))).toEqual(HOME);
  });

  it('a missing path opens Home', async () => {
    expect(await resolveRestoredTab('/Users/gone', deps(false))).toEqual(HOME);
    expect(await resolveRestoredTab('C:\\gone', deps(true))).toEqual(HOME);
  });

  it('an existing path in this OS form is kept', async () => {
    expect(await resolveRestoredTab('/Users/a', deps(false, ['/Users/a']))).toEqual(
      pathLocation('/Users/a'),
    );
    expect(await resolveRestoredTab('C:\\a', deps(true, ['C:\\a']))).toEqual(pathLocation('C:\\a'));
  });

  it("a foreign recycle-bin id opens Home; this machine's own bin place is kept", async () => {
    expect(await resolveRestoredTab('C:\\$Recycle.Bin\\S-1-5-21-1', deps(false))).toEqual(HOME);
    expect(await resolveRestoredTab('/Users/a/.Trash', deps(true))).toEqual(HOME);
    expect(await resolveRestoredTab(tabToken(RECYCLE_BIN), deps(false))).toEqual(RECYCLE_BIN);
    expect(await resolveRestoredTab(tabToken(THIS_PC), deps(true))).toEqual(THIS_PC);
  });

  it('a failed existence check keeps the tab, an unknown token opens Home', async () => {
    const boom = { ...deps(false), exists: () => Promise.reject(new Error('x')) };
    expect(await resolveRestoredTab('/a', boom)).toEqual(pathLocation('/a'));
    expect(await resolveRestoredTab('trove:newer', deps(false))).toEqual(HOME);
  });

  it('pathIsNative tells each OS its own form', () => {
    expect(pathIsNative('C:', true)).toBe(true);
    expect(pathIsNative('\\\\wsl.localhost\\Ubuntu\\home', true)).toBe(true);
    expect(pathIsNative('relative/dir', false)).toBe(false);
  });
});
