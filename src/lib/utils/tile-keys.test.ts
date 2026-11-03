import { describe, expect, it } from 'vitest';
import { rovingKey, tileMove, type TileBox } from './tile-keys';

const key = (k: string, mods: Partial<KeyboardEvent> = {}) =>
  ({ key: k, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...mods }) as Pick<
    KeyboardEvent,
    'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'
  >;

// Home as it lays out: a section of 5 folders (200 wide, 4 to a row, so 4 + 1), a section header,
// then 3 recent files (264 wide). Tiles are 64 high with 4px gaps; the header adds 40px.
const box = (left: number, top: number, width: number): TileBox => ({
  left,
  top,
  width,
  height: 64,
});
const boxes: TileBox[] = [
  box(0, 0, 200), // 0
  box(204, 0, 200), // 1
  box(408, 0, 200), // 2
  box(612, 0, 200), // 3
  box(0, 68, 200), // 4 — second row of the first section
  box(0, 172, 264), // 5 — next section
  box(268, 172, 264), // 6
  box(536, 172, 264), // 7
];

describe('tileMove', () => {
  it('← / → step one tile, across a row break and a section break', () => {
    expect(tileMove(key('ArrowRight'), 0, boxes)).toBe(1);
    expect(tileMove(key('ArrowRight'), 3, boxes)).toBe(4);
    expect(tileMove(key('ArrowRight'), 4, boxes)).toBe(5);
    expect(tileMove(key('ArrowLeft'), 5, boxes)).toBe(4);
  });

  it('stays put at either end', () => {
    expect(tileMove(key('ArrowLeft'), 0, boxes)).toBe(0);
    expect(tileMove(key('ArrowRight'), 7, boxes)).toBe(7);
    expect(tileMove(key('ArrowUp'), 2, boxes)).toBe(2);
    expect(tileMove(key('ArrowDown'), 7, boxes)).toBe(7);
  });

  it('↓ goes to the closest tile in the next row, even when that row is short', () => {
    expect(tileMove(key('ArrowDown'), 0, boxes)).toBe(4);
    // tile 3 is far right; row two holds only tile 4, so that is where ↓ lands
    expect(tileMove(key('ArrowDown'), 3, boxes)).toBe(4);
    // from the last folder row into the recent files, below the header
    expect(tileMove(key('ArrowDown'), 4, boxes)).toBe(5);
  });

  it('↑ goes to the closest tile across in the row above, wider tiles included', () => {
    // the row right above the files is folder row two, which holds only tile 4
    expect(tileMove(key('ArrowUp'), 6, boxes)).toBe(4);
    // a full row above: file 6 (centre 400) lands on folder 1 (centre 304), not 2 (508)
    const two = [box(0, 0, 200), box(204, 0, 200), box(408, 0, 200), ...boxes.slice(5)];
    expect(tileMove(key('ArrowUp'), 4, two)).toBe(1);
    expect(tileMove(key('ArrowUp'), 4, boxes)).toBe(0);
    expect(tileMove(key('ArrowUp'), 7, boxes)).toBe(4);
  });

  it('↑ from the second folder row picks the column above', () => {
    const grid = [box(0, 0, 200), box(204, 0, 200), box(0, 68, 200), box(204, 68, 200)];
    expect(tileMove(key('ArrowUp'), 3, grid)).toBe(1);
    expect(tileMove(key('ArrowDown'), 1, grid)).toBe(3);
  });

  it('Home / End go to the first and last tile of the view', () => {
    expect(tileMove(key('Home'), 6, boxes)).toBe(0);
    expect(tileMove(key('End'), 1, boxes)).toBe(7);
  });

  it('leaves other keys and modified arrows alone (Alt+← is Back)', () => {
    expect(tileMove(key('Enter'), 0, boxes)).toBeNull();
    expect(tileMove(key('F5'), 0, boxes)).toBeNull();
    expect(tileMove(key('ArrowLeft', { altKey: true }), 3, boxes)).toBeNull();
    expect(tileMove(key('ArrowRight', { ctrlKey: true }), 3, boxes)).toBeNull();
    expect(tileMove(key('ArrowDown', { shiftKey: true }), 3, boxes)).toBeNull();
  });

  it('does nothing when focus is not on a tile', () => {
    expect(tileMove(key('ArrowRight'), -1, boxes)).toBeNull();
    expect(tileMove(key('ArrowRight'), 0, [])).toBeNull();
  });
});

describe('rovingKey', () => {
  it('keeps the remembered tile as the one Tab stop while it is shown', () => {
    expect(rovingKey(['a', 'b', 'c'], 'b')).toBe('b');
  });
  it('falls back to the first tile when the remembered one is gone or unset', () => {
    expect(rovingKey(['a', 'b'], 'z')).toBe('a');
    expect(rovingKey(['a', 'b'], null)).toBe('a');
    expect(rovingKey([], 'a')).toBeNull();
  });
});
