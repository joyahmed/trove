import { beforeEach, describe, expect, it } from 'vitest';
import { selection } from './selection.svelte';
import { tabs } from './tabs.svelte';

const order = ['a', 'b', 'c', 'd', 'e'];
const plain = { ctrl: false, shift: false };
const ctrl = { ctrl: true, shift: false };
const shift = { ctrl: false, shift: true };
const both = { ctrl: true, shift: true };
const selected = () => order.filter(selection.has);

describe('selection', () => {
  beforeEach(() => selection.clear());

  it('reveal selects the row alone and asks the list to scroll it into view', () => {
    selection.click('a', plain, order);
    selection.reveal('c');
    expect(selected()).toEqual(['c']);
    expect(selection.focused).toBe('c');
    expect(selection.scrollTo).toBe('c');
  });

  it('is stored per tab: another tab has its own selection and focus', () => {
    selection.click('b', plain, order);
    const first = tabs.activeIndex;
    tabs.open('');
    expect(selected()).toEqual([]);
    expect(selection.focused).toBeNull();
    selection.click('e', plain, order);
    tabs.activate(first);
    expect(selected()).toEqual(['b']);
    expect(selection.focused).toBe('b');
    tabs.close(tabs.list.length - 1);
  });

  it('plain click selects exactly that row and sets the anchor', () => {
    selection.click('b', plain, order);
    selection.click('d', plain, order);
    expect(selected()).toEqual(['d']);
    expect(selection.anchor).toBe('d');
    expect(selection.focused).toBe('d');
  });

  it('ctrl click toggles without touching the others', () => {
    selection.click('a', plain, order);
    selection.click('c', ctrl, order);
    selection.click('a', ctrl, order);
    expect(selected()).toEqual(['c']);
  });

  it('shift click selects the range from the anchor, in either direction', () => {
    selection.click('d', plain, order);
    selection.click('b', shift, order);
    expect(selected()).toEqual(['b', 'c', 'd']);
    selection.click('e', shift, order);
    expect(selected()).toEqual(['d', 'e']);
    expect(selection.anchor).toBe('d');
  });

  it('ctrl+shift adds a range to what is selected', () => {
    selection.click('a', plain, order);
    selection.click('d', ctrl, order);
    selection.click('e', both, order);
    expect(selected()).toEqual(['a', 'd', 'e']);
  });

  it('arrow keys move a single selection and clamp at the ends', () => {
    selection.move(order, 1, plain);
    expect(selected()).toEqual(['a']);
    selection.move(order, -5, plain);
    expect(selected()).toEqual(['a']);
    selection.move(order, 0, plain, order.length - 1);
    expect(selected()).toEqual(['e']);
    selection.move(order, 9, plain);
    expect(selected()).toEqual(['e']);
  });

  it('shift+arrow extends from the anchor', () => {
    selection.click('c', plain, order);
    selection.move(order, 1, shift);
    selection.move(order, 1, shift);
    expect(selected()).toEqual(['c', 'd', 'e']);
    selection.move(order, -3, shift);
    expect(selected()).toEqual(['b', 'c']);
  });

  it('shift+click or shift+arrow with the anchor folded away selects the target instead of nothing', () => {
    selection.click('gone', { ctrl: false, shift: false }, ['gone', 'a', 'b']);
    const shown = ['a', 'b', 'c'];
    selection.click('b', { ctrl: false, shift: true }, shown);
    expect([...selection.paths]).toEqual(['b']);
    expect(selection.anchor).toBe('b');
    selection.click('gone', { ctrl: false, shift: false }, ['gone', 'a', 'b']);
    selection.move(shown, 1, { ctrl: false, shift: true });
    expect([...selection.paths]).toEqual(['a']);
    selection.move(shown, 1, { ctrl: false, shift: true });
    expect([...selection.paths]).toEqual(['a', 'b']);
  });

  it('selectAll and count', () => {
    selection.selectAll(order);
    expect(selection.count).toBe(5);
  });

  it('right-click on an unselected row makes it the sole selection', () => {
    selection.click('a', plain, order);
    selection.click('b', ctrl, order);
    selection.contextClick('d');
    expect(selected()).toEqual(['d']);
    expect(selection.anchor).toBe('d');
    expect(selection.focused).toBe('d');
  });

  it('right-click on a selected row keeps the set and only moves the focus', () => {
    selection.click('a', plain, order);
    selection.click('c', shift, order);
    selection.contextClick('b');
    expect(selected()).toEqual(['a', 'b', 'c']);
    expect(selection.anchor).toBe('a');
    expect(selection.focused).toBe('b');
  });

  it('retain drops rows that disappeared', () => {
    selection.selectAll(order);
    selection.click('e', ctrl, order);
    selection.retain(['a', 'b']);
    expect(selected()).toEqual(['a', 'b']);
    expect(selection.focused).toBeNull();
    expect(selection.anchor).toBeNull();
  });

  it('deselect (Esc) clears the selection but keeps the focused row, so Space and arrows go on', () => {
    selection.click('c', plain, order);
    selection.deselect();
    expect(selected()).toEqual([]);
    expect(selection.focused).toBe('c');
    // Space after Esc: the list's plain-Space rule selects the focused row
    selection.click(selection.focused!, plain, order);
    expect(selected()).toEqual(['c']);
    // Esc then ArrowDown moves from the old focus
    selection.deselect();
    selection.move(order, 1, plain);
    expect(selection.focused).toBe('d');
    expect(selected()).toEqual(['d']);
  });
});
