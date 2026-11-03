import { beforeEach, describe, expect, it } from 'vitest';
import { tabs } from './tabs.svelte';

describe('tabs', () => {
  beforeEach(() => {
    while (tabs.list.length > 1) tabs.close(tabs.list.length - 1);
    tabs.activate(0);
  });

  it('starts with one tab and never closes the last one', () => {
    expect(tabs.list).toHaveLength(1);
    tabs.close();
    expect(tabs.list).toHaveLength(1);
  });

  it('open appends and activates; close keeps a sensible active index', () => {
    tabs.open('');
    tabs.open('');
    expect(tabs.list).toHaveLength(3);
    expect(tabs.activeIndex).toBe(2);
    tabs.close(0); // closing before the active one shifts it left
    expect(tabs.activeIndex).toBe(1);
    expect(tabs.list).toHaveLength(2);
    tabs.close(); // closing the last active one moves to the new last
    expect(tabs.activeIndex).toBe(0);
  });

  it('next and prev wrap around', () => {
    tabs.open('');
    tabs.open('');
    tabs.activate(2);
    tabs.next();
    expect(tabs.activeIndex).toBe(0);
    tabs.prev();
    expect(tabs.activeIndex).toBe(2);
  });

  it('active is the tab at activeIndex', () => {
    const t = tabs.open('');
    expect(tabs.active).toBe(t);
    tabs.activate(0);
    expect(tabs.active).not.toBe(t);
  });
});

describe('tabs: close, reopen, move, jump', () => {
  beforeEach(() => {
    while (tabs.list.length > 1) tabs.close(tabs.list.length - 1);
    tabs.activate(0);
    tabs.closed.length = 0;
  });

  it('close reports "last" for the only tab instead of removing it', () => {
    expect(tabs.close()).toBe('last');
    expect(tabs.list).toHaveLength(1);
    tabs.open('');
    expect(tabs.close()).toBe('closed');
  });

  it('reopen brings back the location of the most recently closed folder tab', () => {
    const t = tabs.open('');
    t.location = { kind: 'path', path: 'C:\\gone' };
    tabs.close();
    expect(tabs.closed).toEqual([{ kind: 'path', path: 'C:\\gone' }]);
    const back = tabs.reopen();
    expect(back).toBeDefined();
    expect(tabs.closed).toEqual([]);
    expect(tabs.reopen()).toBeUndefined();
  });

  it('move reorders and keeps the active tab active', () => {
    const b = tabs.open('');
    const c = tabs.open('');
    tabs.activate(1); // b
    tabs.move(0, 2); // a goes last: [b, c, a]
    expect(tabs.list[0]).toBe(b);
    expect(tabs.list[1]).toBe(c);
    expect(tabs.active).toBe(b);
    expect(tabs.activeIndex).toBe(0);
    tabs.move(5, 0); // out of range: no-op
    expect(tabs.list[0]).toBe(b);
  });

  it('jump goes to the nth tab and 9 is always the last', () => {
    tabs.open('');
    tabs.open('');
    tabs.jump(1);
    expect(tabs.activeIndex).toBe(0);
    tabs.jump(9);
    expect(tabs.activeIndex).toBe(2);
    tabs.jump(7); // beyond the end: unchanged
    expect(tabs.activeIndex).toBe(2);
  });
});

describe('tabs.openForLaunch', () => {
  it('opens a tab for a folder launch', () => {
    const before = tabs.list.length;
    expect(tabs.openForLaunch('C:\\Users')).not.toBeNull();
    expect(tabs.list).toHaveLength(before + 1);
    expect(tabs.openForLaunch(undefined)).not.toBeNull();
  });

  it('opens no tab for an Explorer-only place, so none is left blank', () => {
    const before = tabs.list.length;
    expect(tabs.openForLaunch('::{26EE0668-A00A-44D7-9371-BEB064C98683}')).toBeNull();
    expect(tabs.openForLaunch('shell:AppsFolder')).toBeNull();
    expect(tabs.list).toHaveLength(before);
  });

  it('still opens a tab for This PC and the Recycle Bin', () => {
    expect(tabs.openForLaunch('::{20D04FE0-3AEA-1069-A2D8-08002B30309D}')).not.toBeNull();
    expect(tabs.openForLaunch('::{645FF040-5081-101B-9F08-00AA002F954E}')).not.toBeNull();
  });
});
