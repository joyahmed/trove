import { describe, expect, it, vi } from 'vitest';
import { createSessionRestore } from './session-restore';
import type { RestorePlan, WindowPlan } from './restore-tabs';

const setup = () => {
  const calls: string[] = [];
  const deps = {
    openHere: vi.fn((p: WindowPlan) => void calls.push(`here ${p.tabs.join(',')}`)),
    openWindows: vi.fn(async (ps: WindowPlan[]) => void calls.push(`open ${ps.length}`)),
    hold: vi.fn(async (ps: WindowPlan[]) => void calls.push(`hold ${ps.length}`)),
    save: vi.fn(async (p: WindowPlan) => void calls.push(`save ${p.tabs.join(',')}`)),
    onError: vi.fn(),
  };
  return { calls, deps, session: createSessionRestore(deps) };
};

const plan: RestorePlan = {
  main: { tabs: ['C:\\a'], active: 0 },
  others: [
    { tabs: ['D:\\x', 'D:\\y'], active: 1 },
    { tabs: ['E:\\z'], active: 0 },
  ],
};

describe('session restore: saves wait for the restore', () => {
  it('a save before the restore is held, and only the latest goes out after it', async () => {
    const { calls, session } = setup();
    // mount: the start tab is no folder; then a navigation before the restore lands
    session.save({ tabs: [], active: 0 });
    session.save({ tabs: ['C:\\home'], active: 0 });
    expect(calls).toEqual([]); // a crash now leaves the last session on disk untouched
    await session.restore(plan, false);
    expect(calls).toEqual(['here C:\\a', 'open 2', 'save C:\\home']);
  });

  it('after the restore every change goes out, repeats skipped', async () => {
    const { calls, session } = setup();
    await session.restore({ main: { tabs: [], active: 0 }, others: [] }, false);
    session.save({ tabs: ['C:\\a'], active: 0 });
    session.save({ tabs: ['C:\\a'], active: 0 });
    session.save({ tabs: ['C:\\a', 'C:\\b'], active: 1 });
    expect(calls.filter((c) => c.startsWith('save'))).toEqual(['save C:\\a', 'save C:\\a,C:\\b']);
  });

  it('a failed save is reported, not thrown', async () => {
    const { deps, session } = setup();
    deps.save.mockRejectedValueOnce(new Error('disk full'));
    await session.restore({ main: { tabs: [], active: 0 }, others: [] }, false);
    session.save({ tabs: ['C:\\a'], active: 0 });
    await Promise.resolve();
    await Promise.resolve();
    expect(deps.onError).toHaveBeenCalledWith('saveWindowTabs', expect.any(Error));
  });
});

describe('session restore: a hidden start keeps the other windows back', () => {
  it('others are held, not opened, until the window is shown', async () => {
    const { calls, deps, session } = setup();
    await session.restore(plan, true);
    expect(deps.openWindows).not.toHaveBeenCalled();
    expect(deps.hold).toHaveBeenCalledWith(plan.others);
    expect(session.pending).toEqual(plan.others);
    // held in the file BEFORE main's own save can go out
    session.save({ tabs: ['C:\\a'], active: 0 });
    expect(calls).toEqual(['here C:\\a', 'hold 2', 'save C:\\a']);

    await session.shown();
    expect(deps.hold).toHaveBeenLastCalledWith([]); // released first, then opened
    expect(deps.openWindows).toHaveBeenCalledWith(plan.others);
    expect(calls.slice(-2)).toEqual(['hold 0', 'open 2']);
    expect(session.pending).toEqual([]);
  });

  it('a second show opens nothing again; a normal start never holds', async () => {
    const hidden = setup();
    await hidden.session.restore(plan, true);
    await hidden.session.shown();
    await hidden.session.shown();
    expect(hidden.deps.openWindows).toHaveBeenCalledTimes(1);

    const normal = setup();
    await normal.session.restore(plan, false);
    await normal.session.shown();
    expect(normal.deps.hold).not.toHaveBeenCalled();
    expect(normal.deps.openWindows).toHaveBeenCalledTimes(1);
  });

  it('a hold that fails still lets the start finish and the windows open on show', async () => {
    const { deps, session } = setup();
    deps.hold.mockRejectedValueOnce(new Error('no config dir'));
    await session.restore(plan, true);
    expect(session.restored).toBe(true);
    expect(deps.onError).toHaveBeenCalledWith('holdWindows', expect.any(Error));
    await session.shown();
    expect(deps.openWindows).toHaveBeenCalledWith(plan.others);
  });
});
