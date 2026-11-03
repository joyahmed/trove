import { describe, expect, it, vi } from 'vitest';
import { captureFocus, FILE_LIST_GRID, isChromeButton, type FocusRoot } from './focus-return';

const el = (isConnected = true) => ({ focus: vi.fn(), isConnected });

const rootWith = (active: unknown, grid: unknown = null) => {
  const body = { tagName: 'BODY' };
  const root: FocusRoot = {
    activeElement: active === 'body' ? body : active,
    body,
    querySelector: vi.fn((s: string) => (s === FILE_LIST_GRID ? grid : null)),
  };
  return root;
};

describe('captureFocus (Mac, fleet #521: Keep both left Delete dead)', () => {
  it('gives focus back to the file list that had it', () => {
    const grid = el();
    const root = rootWith(grid, grid);
    const restore = captureFocus(root);
    root.activeElement = el(); // the dialog's button took it
    restore();
    expect(grid.focus).toHaveBeenCalledWith({ preventScroll: true });
  });

  it('gives it back to any other opener too, not only the list', () => {
    const search = el();
    const grid = el();
    captureFocus(rootWith(search, grid))();
    expect(search.focus).toHaveBeenCalledTimes(1);
    expect(grid.focus).not.toHaveBeenCalled();
  });

  it('falls back to the file list when nothing had focus', () => {
    const grid = el();
    captureFocus(rootWith('body', grid))();
    expect(grid.focus).toHaveBeenCalledTimes(1);
  });

  it('falls back to the file list when the opener left the page (a menu item)', () => {
    const item = el();
    const grid = el();
    const restore = captureFocus(rootWith(item, grid));
    item.isConnected = false;
    restore();
    expect(item.focus).not.toHaveBeenCalled();
    expect(grid.focus).toHaveBeenCalledTimes(1);
  });

  it('finds the Recycle Bin list as the fallback (it is a listbox, not a grid)', () => {
    const bin = el();
    const root = rootWith('body');
    root.querySelector = vi.fn((s: string) => (s.includes('[data-focus-home]') ? bin : null));
    captureFocus(root)();
    expect(bin.focus).toHaveBeenCalledTimes(1);
  });

  it('skips an opener that is now disabled (Empty bin button after emptying)', () => {
    const empty = { ...el(), disabled: false };
    const bin = el();
    const restore = captureFocus(rootWith(empty, bin));
    empty.disabled = true;
    restore();
    expect(empty.focus).not.toHaveBeenCalled();
    expect(bin.focus).toHaveBeenCalledTimes(1);
  });

  it('does nothing when there is no opener and no list (Home, This PC)', () => {
    expect(() => captureFocus(rootWith('body', null))()).not.toThrow();
  });

  it('does nothing without a document (tests, SSR)', () => {
    expect(() => captureFocus(undefined)()).not.toThrow();
  });
});

/** An element with a tag, a role and the containers `closest` finds it inside. */
const tagged = (tagName: string, role: string | null = null, inside: string[] = []) => ({
  ...el(),
  tagName,
  getAttribute: (name: string) => (name === 'role' ? role : null),
  closest: (selector: string) =>
    inside.some((c) => selector.split(',').some((s) => s.trim() === c)) ? {} : null,
});

describe('a chrome button does not keep focus (Linux 2026-10-07, row 5a)', () => {
  it('Settings opened with the gear and closed with × gives focus to the file list', () => {
    const gear = tagged('BUTTON');
    const grid = el();
    captureFocus(rootWith(gear, grid))();
    expect(gear.focus).not.toHaveBeenCalled();
    expect(grid.focus).toHaveBeenCalledWith({ preventScroll: true });
  });

  it('a role="button" in the title bar counts as chrome too', () => {
    const tab = tagged('DIV', 'button');
    const grid = el();
    captureFocus(rootWith(tab, grid))();
    expect(grid.focus).toHaveBeenCalledTimes(1);
    expect(tab.focus).not.toHaveBeenCalled();
  });

  it('a button inside another dialog gets focus back (Settings ▸ Reset → Confirm)', () => {
    const reset = tagged('BUTTON', null, ['[role="dialog"]']);
    const grid = el();
    captureFocus(rootWith(reset, grid))();
    expect(reset.focus).toHaveBeenCalledTimes(1);
    expect(grid.focus).not.toHaveBeenCalled();
  });

  it('a text field, a list row and a sidebar place get focus back', () => {
    for (const opener of [
      tagged('INPUT'),
      tagged('DIV', 'row', ['[role="grid"]']),
      tagged('BUTTON', null, ['aside']),
    ]) {
      const grid = el();
      captureFocus(rootWith(opener, grid))();
      expect(opener.focus).toHaveBeenCalledTimes(1);
      expect(grid.focus).not.toHaveBeenCalled();
    }
  });

  it('with no file list showing (a place view), the chrome button gets it back', () => {
    const gear = tagged('BUTTON');
    captureFocus(rootWith(gear, null))();
    expect(gear.focus).toHaveBeenCalledTimes(1);
  });

  it('isChromeButton: buttons outside a list, dialog or sidebar only', () => {
    expect(isChromeButton(tagged('BUTTON'))).toBe(true);
    expect(isChromeButton(tagged('SPAN', 'button'))).toBe(true);
    expect(isChromeButton(tagged('INPUT'))).toBe(false);
    expect(isChromeButton(tagged('BUTTON', null, ['[role="listbox"]']))).toBe(false);
    expect(isChromeButton(el())).toBe(false);
  });
});
