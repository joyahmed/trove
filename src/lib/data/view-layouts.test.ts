import { describe, expect, it } from 'vitest';
import {
  CONTENT_ROW_PX,
  TILES_CARD,
  arrowAxis,
  detailsRowPx,
  layoutFor,
  viewLayouts,
} from './view-layouts';
import { itemsPerChunk } from '$lib/utils/virtual';

describe('details row height', () => {
  it('is 24 px on a Mac and 28 px everywhere else', () => {
    expect(detailsRowPx(true)).toBe(24);
    expect(detailsRowPx(false)).toBe(28);
    expect(layoutFor('details', 48, true).chunkSize).toBe(24);
    expect(layoutFor('details', 48, false).chunkSize).toBe(28);
  });
  it('keeps the group heading at 28 px and leaves list and grid alone', () => {
    expect(layoutFor('details', 48, true).headerSize).toBe(28);
    expect(layoutFor('list', 48, true)).toEqual(viewLayouts.list);
    expect(layoutFor('grid', 48, true)).toEqual(layoutFor('grid', 48, false));
  });
});

describe('Small icons, Tiles and Content (plan 15 G.51)', () => {
  it('Small icons packs the 224 px list item across, then down', () => {
    const small = layoutFor('small', 48);
    expect(small.horizontal).toBe(false);
    expect(small.chunkSize).toBe(22);
    // 224 px item + 8 px gap: an 800 px pane fits 3, a 1000 px one 4
    expect(itemsPerChunk(small, 800, 600)).toBe(3);
    expect(itemsPerChunk(small, 1000, 600)).toBe(4);
  });

  it('Tiles packs 256 × 64 cards in rows', () => {
    const tiles = layoutFor('tiles', 256);
    expect(tiles.chunkSize).toBe(TILES_CARD.height + TILES_CARD.gap);
    expect(tiles.itemSpan).toBe(TILES_CARD.width + TILES_CARD.gap);
    expect(itemsPerChunk(tiles, 800, 600)).toBe(3);
  });

  it('Content is one full-width row per item', () => {
    const content = layoutFor('content', 48);
    expect(content.chunkSize).toBe(CONTENT_ROW_PX);
    expect(itemsPerChunk(content, 1200, 600)).toBe(1);
  });

  it('the arrows follow the packing: across-then-down hops rows, list hops columns', () => {
    expect(arrowAxis(layoutFor('grid', 96))).toBe('rows');
    expect(arrowAxis(layoutFor('small', 48))).toBe('rows');
    expect(arrowAxis(layoutFor('tiles', 48))).toBe('rows');
    expect(arrowAxis(layoutFor('list', 48))).toBe('columns');
    expect(arrowAxis(layoutFor('details', 48))).toBe('single');
    expect(arrowAxis(layoutFor('content', 48))).toBe('single');
  });
});
