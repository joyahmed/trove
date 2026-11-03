import { describe, expect, it } from 'vitest';
import { guardTooltips } from './tooltip-guard';

// A document stub: listeners by type, and a menu that is "open" when `menu.open` is true.
const setup = () => {
  const handlers: Record<string, (e: unknown) => void> = {};
  const menu = { open: false };
  const doc = {
    addEventListener: (t: string, f: (e: unknown) => void) => (handlers[t] = f),
    removeEventListener: (t: string) => delete handlers[t],
    querySelector: () => (menu.open ? {} : null),
  } as unknown as Document;
  let title: string | null = '/home/alex/app';
  const el = {
    getAttribute: () => title,
    removeAttribute: () => (title = null),
    setAttribute: (_n: string, v: string) => (title = v),
  };
  const target = { closest: () => el };
  return { handlers, menu, doc, target, title: () => title };
};

describe('guardTooltips', () => {
  it('holds the title on right-click and while a menu is open, restores it after', () => {
    const t = setup();
    guardTooltips(t.doc);
    t.handlers.contextmenu({ target: t.target });
    expect(t.title()).toBeNull();
    t.menu.open = true;
    t.handlers.pointerover({ target: t.target });
    expect(t.title()).toBeNull();
    t.menu.open = false;
    t.handlers.pointermove({ target: t.target });
    expect(t.title()).toBe('/home/alex/app');
  });

  it('leaves titles alone when no menu is open', () => {
    const t = setup();
    guardTooltips(t.doc);
    t.handlers.pointerover({ target: t.target });
    expect(t.title()).toBe('/home/alex/app');
  });

  it('cleanup restores a held title and removes the listeners', () => {
    const t = setup();
    const off = guardTooltips(t.doc);
    t.handlers.contextmenu({ target: t.target });
    off();
    expect(t.title()).toBe('/home/alex/app');
    expect(Object.keys(t.handlers)).toHaveLength(0);
  });
});
