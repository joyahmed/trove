import { describe, expect, it } from 'vitest';
import {
  explorerViewOrder,
  isStep,
  stepGlyph,
  stepIconSize,
  stepLabel,
  stepView,
  viewSteps,
} from './view-steps';
import { glyphNames } from '$lib/data/glyphs';
import { VIEW_MODES } from '$lib/state/settings.svelte';

describe('stepView', () => {
  it('walks all eight of Explorer views, smallest to largest', () => {
    let s = viewSteps[0];
    const seen = [stepLabel(s)];
    for (let i = 0; i < 7; i++) {
      s = stepView(s, 1);
      seen.push(stepLabel(s));
    }
    expect(seen).toEqual([
      'Content',
      'Tiles',
      'Details',
      'List',
      'Small icons',
      'Medium icons',
      'Large icons',
      'Extra large icons',
    ]);
  });

  it('clamps at both ends', () => {
    expect(stepView({ view: 'grid', iconSize: 256 }, 1)).toEqual({ view: 'grid', iconSize: 256 });
    expect(stepView({ view: 'content', iconSize: 96 }, -1)).toEqual({
      view: 'content',
      iconSize: 96,
    });
  });

  it('a step out of the grid keeps its size for the way back', () => {
    expect(stepView({ view: 'grid', iconSize: 48 }, -1)).toEqual({ view: 'small', iconSize: 48 });
    expect(stepView({ view: 'grid', iconSize: 96 }, -1)).toEqual({ view: 'grid', iconSize: 48 });
    expect(stepView({ view: 'details', iconSize: 256 }, -1)).toEqual({
      view: 'tiles',
      iconSize: 256,
    });
  });

  it('an unknown combination starts from the smallest step', () => {
    expect(stepView({ view: 'grid', iconSize: 64 as never }, 1)).toEqual({
      view: 'tiles',
      iconSize: 64,
    });
  });
});

describe('the eight views', () => {
  it('Explorer order is biggest first: Ctrl+Shift+1 extra large … 6 details, 7 tiles, 8 content', () => {
    expect(explorerViewOrder.map(stepLabel)).toEqual([
      'Extra large icons',
      'Large icons',
      'Medium icons',
      'Small icons',
      'List',
      'Details',
      'Tiles',
      'Content',
    ]);
  });

  it('every view mode has a step, and every step a drawn glyph', () => {
    expect(new Set(viewSteps.map((s) => s.view))).toEqual(new Set(VIEW_MODES));
    for (const s of viewSteps) expect(glyphNames).toContain(stepGlyph(s));
  });

  it('only a grid step names an icon size', () => {
    expect(stepIconSize({ view: 'grid', iconSize: 96 })).toBe(96);
    expect(stepIconSize({ view: 'tiles', iconSize: 96 })).toBeUndefined();
  });

  it('isStep ignores the icon size outside the grid', () => {
    expect(isStep({ view: 'tiles', iconSize: 48 }, { view: 'tiles', iconSize: 256 })).toBe(true);
    expect(isStep({ view: 'grid', iconSize: 48 }, { view: 'grid', iconSize: 256 })).toBe(false);
  });
});
