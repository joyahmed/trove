import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync('src/styles/mac/base.css', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const card = readFileSync(
  'src/lib/components/dialogs/custom-commands-parts/DetectedCommands.svelte',
  'utf8',
);

/** every selector (text before a `{`) of base.css that names `.border-divider` */
const selectors = css
  .split('{')
  .slice(0, -1)
  .map((s) => s.slice(s.lastIndexOf('}') + 1).trim())
  .filter((s) => s.includes('.border-divider'));

describe('Mac dialog push-button rule', () => {
  it('finds the border-divider selectors', () => {
    expect(selectors.length).toBe(3);
  });
  it('exempts tiles (data-tile) from every border-divider selector', () => {
    for (const s of selectors) expect(s, s).toContain(':not([data-tile])');
  });
  it('marks the found-app card in Customize as a tile', () => {
    const tag = card.match(/<button\s[^>]*?class="[^"]*border-divider[^"]*h-14[^>]*>/s);
    expect(tag, 'card button exists').not.toBeNull();
    expect(tag![0]).toMatch(/\sdata-tile(\s|=|>)/);
  });
});
