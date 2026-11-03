// The layer scale is only worth having if nothing sidesteps it. Every overlay in the app was
// once `z-50`, so what painted on top came down to DOM order in Shell.svelte — which is how
// clicking "Customize context menu…" inside Settings opened a dialog *behind* Settings.
// docs/plans/07-the-log-and-four-bugs.md Phase D.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync('src/app.css', 'utf8');

const layer = (name: string) => {
  const m = new RegExp(`--z-index-${name}:\\s*(\\d+)`).exec(css);
  return m ? Number(m[1]) : null;
};

/** Low to high. Anything that must sit above something else belongs in this list. */
const SCALE = [
  'chrome',
  'infotip',
  'toast',
  'dialog',
  'dialog-nested',
  'dialog-urgent',
  'menu',
  'drag',
] as const;

const svelteFiles = (dir: string): string[] =>
  readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return svelteFiles(full);
    return full.endsWith('.svelte') ? [full] : [];
  });

describe('the layer scale', () => {
  it('defines every layer', () => {
    for (const name of SCALE) expect(layer(name), `--z-index-${name}`).not.toBeNull();
  });

  it('is strictly increasing, so the names carry the ordering', () => {
    const values = SCALE.map((n) => layer(n) ?? -1);
    for (let i = 1; i < values.length; i++) {
      expect(values[i], `${SCALE[i]} must sit above ${SCALE[i - 1]}`).toBeGreaterThan(
        values[i - 1],
      );
    }
  });

  /** ⛔ A context menu opened inside a dialog is a real flow; at equal z-index it was a coin toss. */
  it('puts menus above every dialog, and the drag ghost above everything', () => {
    const menu = layer('menu') ?? 0;
    for (const d of ['dialog', 'dialog-nested', 'dialog-urgent']) {
      expect(menu).toBeGreaterThan(layer(d) ?? 0);
    }
    expect(layer('drag') ?? 0).toBeGreaterThan(menu);
  });

  /**
   * ⛔ The regression guard. A raw `z-<number>` anywhere in a component is how the app got into
   * this state: the number says nothing about what it should sit above, and two of them at the
   * same value silently fall back to DOM order.
   */
  it('no component sets a raw numeric z-index', () => {
    const offenders = svelteFiles('src/lib')
      .concat(svelteFiles('src/routes'))
      .flatMap((file) => {
        const hits = readFileSync(file, 'utf8').match(/\bz-\[?-?\d/g);
        return hits ? [`${file}: ${hits.join(', ')}`] : [];
      });
    expect(offenders).toEqual([]);
  });
});
