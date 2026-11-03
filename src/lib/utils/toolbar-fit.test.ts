import { describe, expect, it } from 'vitest';
import { splitHint, toolbarOverflowItems } from '$lib/data/toolbar-overflow';
import { TOOLBAR_FULL_PX, toolbarFit, type ToolbarPart } from './toolbar-fit';

describe('toolbarFit', () => {
  it('needs 816px with every part showing (the view switch has four segments in a folder)', () => {
    expect(TOOLBAR_FULL_PX).toBe(816);
  });
  it('hides nothing at 816', () => {
    expect(toolbarFit(816)).toEqual({ collapsed: [], overflow: false });
  });
  it('at 784 (an 800px window) the view switch gives way so the gear stays on the toolbar', () => {
    expect(toolbarFit(784)).toEqual({ collapsed: ['view'], overflow: true });
  });
  it('hides the view switch and Details / Settings at 700', () => {
    expect(toolbarFit(700)).toEqual({ collapsed: ['view', 'trailing'], overflow: true });
  });
  it('also drops the New label at 600', () => {
    expect(toolbarFit(600).collapsed).toEqual(['view', 'trailing', 'newLabel']);
  });
  it('drops refresh and search last, in that order', () => {
    const at = (w: number) => toolbarFit(w).collapsed;
    expect(at(560)).not.toContain('refresh');
    for (let w = 816; w >= 0; w--) {
      const c = at(w);
      if (c.includes('search')) expect(c).toContain('refresh');
    }
    expect(at(400)).toContain('search');
  });
  it('has everything gone below 372', () => {
    for (const w of [300, 0]) {
      expect(toolbarFit(w).collapsed).toEqual([
        'view',
        'trailing',
        'newLabel',
        'refresh',
        'search',
      ]);
      expect(toolbarFit(w).overflow).toBe(true);
    }
  });
  it('never hides anything when width is unmeasured', () => {
    expect(toolbarFit(Infinity).collapsed).toEqual([]);
  });
});

describe('toolbarOverflowItems', () => {
  const visibleKeys = (gone: ToolbarPart[]) =>
    toolbarOverflowItems((p) => gone.includes(p))
      .filter((i) => i.kind === 'divider' || i.visible?.() !== false)
      .map((i) => i.key);

  it('shows no row while every part is on the toolbar', () => {
    expect(visibleKeys([])).toEqual([]);
  });
  it('shows a row only while its part is collapsed', () => {
    expect(visibleKeys(['refresh'])).toEqual(['refresh']);
    expect(visibleKeys(['search'])).toEqual(['find-anything']);
    expect(visibleKeys(['trailing'])).toEqual(['details', 'settings']);
    expect(visibleKeys(['newLabel'])).toEqual([]);
    expect(visibleKeys(['view']).length).toBe(1);
  });
});

describe('splitHint', () => {
  it('splits a trailing (shortcut) into its own column', () => {
    expect(splitHint('Details pane (Alt+P)')).toEqual({ label: 'Details pane', shortcut: 'Alt+P' });
  });
  it('leaves a plain label alone', () => {
    expect(splitHint('Settings')).toEqual({ label: 'Settings' });
  });
});
