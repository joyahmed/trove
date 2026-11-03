import { beforeEach, describe, expect, it } from 'vitest';
import { selection } from './selection.svelte';

const order = ['a', 'b', 'c', 'd', 'e'];

describe('selection: Space and rubber-band helpers', () => {
  beforeEach(() => selection.clear());

  it('toggleFocused flips the focused row and moves the anchor there', () => {
    selection.click('b', { ctrl: false, shift: false }, order);
    selection.move(order, 2, { ctrl: true, shift: false }); // focus d, selection stays b
    expect(selection.focused).toBe('d');
    selection.toggleFocused();
    expect([...selection.paths].sort()).toEqual(['b', 'd']);
    expect(selection.anchor).toBe('d');
    selection.toggleFocused();
    expect([...selection.paths]).toEqual(['b']);
  });

  it('extendTo selects from the anchor to the focused row', () => {
    selection.click('b', { ctrl: false, shift: false }, order);
    selection.move(order, 2, { ctrl: true, shift: false }); // focus d without selecting
    selection.extendTo(order);
    expect([...selection.paths].sort()).toEqual(['b', 'c', 'd']);
    expect(selection.focused).toBe('d');
  });

  it('addAll keeps what was there; replaceAll does not', () => {
    selection.click('a', { ctrl: false, shift: false }, order);
    selection.addAll(['c', 'd']);
    expect([...selection.paths].sort()).toEqual(['a', 'c', 'd']);
    selection.replaceAll(['e']);
    expect([...selection.paths]).toEqual(['e']);
    expect(selection.focused).toBe('a'); // the focus is the keyboard's, not the band's
  });

  it('invert flips every listed row and leaves the focus alone', () => {
    selection.click('b', { ctrl: false, shift: false }, order);
    selection.click('d', { ctrl: true, shift: false }, order);
    selection.invert(order);
    expect([...selection.paths].sort()).toEqual(['a', 'c', 'e']);
    expect(selection.focused).toBe('d');
    selection.invert(order);
    expect([...selection.paths].sort()).toEqual(['b', 'd']);
  });
});
