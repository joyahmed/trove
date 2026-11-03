import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const dir = 'src/lib/components/terminal/';
const pane = readFileSync(dir + 'TerminalPane.svelte', 'utf8');

const lin = (hex: string) => {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const [r, g, b] = c.map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a: string, b: string) => {
  const [hi, lo] = [lin(a), lin(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};
const hue = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const m = Math.max(r, g, b);
  const d = m - Math.min(r, g, b);
  if (d === 0) return 0;
  const x = m === r ? ((g - b) / d) % 6 : m === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return (x * 60 + 360) % 360;
};
const NAMES = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white'];

describe.each([
  { theme: 'light', file: 'terminal-light.css' },
  { theme: 'dark', file: 'terminal-dark.css' },
])('$theme terminal palette', ({ file }) => {
  const css = readFileSync(dir + file, 'utf8');
  const vars = (name: string) => css.match(new RegExp(`--${name}: *(#[0-9a-f]{6})`, 'i'))![1];
  const bg = vars('term-bg');
  // ANSI black (0) is used for de-emphasised text: it must read (3:1), not match real text (4.5:1).
  const rows = Array.from({ length: 16 }, (_, i) => {
    const hex = vars(`term-color-${i}`);
    return { i, label: `${i < 8 ? '' : 'bright '}${NAMES[i % 8]}`, hex, r: ratio(hex, bg) };
  });

  it('is loaded by the pane', () => {
    expect(pane).toContain(`import './${file}'`);
  });
  it('ANSI black is at least 3:1 on the background', () => {
    expect(rows[0].r).toBeGreaterThanOrEqual(3);
  });
  it.each(rows.filter((x) => x.i !== 0))(
    'ANSI $i ($label $hex) is at least 4.5:1 on the background',
    ({ r }) => {
      expect(r).toBeGreaterThanOrEqual(4.5);
    },
  );
  it.each([1, 2, 3, 4, 5, 6])('bright %i keeps the hue of normal %i (within 30 degrees)', (n) => {
    const d = Math.abs(hue(rows[n].hex) - hue(rows[n + 8].hex));
    expect(Math.min(d, 360 - d)).toBeLessThanOrEqual(30);
  });
  it('default text clears 4.5:1 and the cursor 3:1', () => {
    expect(ratio(vars('term-fg'), bg)).toBeGreaterThanOrEqual(4.5);
    expect(ratio(vars('term-cursor'), bg)).toBeGreaterThanOrEqual(3);
  });
  it('lists the ratios', () => {
    console.log(rows.map((x) => `${x.i} ${x.label} ${x.hex} ${x.r.toFixed(2)}`).join('\n'));
  });
});
