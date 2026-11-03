import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync('src/app.css', 'utf8');
const toggle = readFileSync(
  'src/lib/components/panes/details-parts/AttributeToggle.svelte',
  'utf8',
);

describe('dialog focus ring', () => {
  it('keeps the :focus-visible rule', () => {
    expect(css).toMatch(/\[role='alertdialog'\]\) :focus-visible,/);
  });
  it('also rings plain :focus when the last input was the keyboard', () => {
    expect(css).toMatch(/:root\[data-keyboard\]\s+:is\(\[role='dialog'\][^{]*button[^{]*\):focus/);
  });
});

// G.75: the app's ring outside dialogs too, keyboard focus only, in `@layer base` so a control's
// own `outline-none` utility still wins.
describe('focus ring outside dialogs', () => {
  const start = css.indexOf('plan 15 G.75');
  const block = css.slice(css.indexOf('@layer base {', start), css.indexOf('/* The checkbox'));

  it('is one layered rule that rings every :focus-visible element in the accent', () => {
    expect(start).toBeGreaterThan(0);
    expect(block).toMatch(/^@layer base \{\s+:focus-visible,/);
    expect(block).toMatch(
      /\):focus:not\(\[tabindex='-1'\]\),[^{]*\{\s*outline: 2px solid var\(--color-accent\);/s,
    );
  });

  it('rings plain :focus only when the last input was a key, and never on a Mac', () => {
    // the selector list of the first rule, comments out
    const selectors = block
      .slice(block.indexOf(':focus-visible'), block.indexOf('{', block.indexOf(':focus-visible')))
      .replace(/\/\*[\s\S]*?\*\//g, '');
    const plainFocus = selectors.match(/:focus(?!-visible)/g) ?? [];
    const flagged = selectors.match(/:root\[data-keyboard\]:not\(\[data-os='macos'\]\)/g) ?? [];
    // every plain-:focus selector hangs off the keyboard flag, so a click shows no ring
    expect(plainFocus.length).toBe(2);
    expect(flagged.length).toBe(plainFocus.length);
  });

  it('reaches the roving place tiles, whose tabindex is -1', () => {
    expect(block).toContain('[data-place-tile]:focus');
  });

  it("takes AppKit's ring under Mac style, as dialogs do", () => {
    expect(block).toMatch(
      /:root\[data-os='macos'\] :focus-visible \{\s*outline: 3px solid var\(--mac-focus-ring\);/,
    );
  });
});

describe('checkbox', () => {
  it('uses the themed class, not the native accent-accent square', () => {
    expect(toggle).toContain('class="trove-check"');
    expect(toggle).not.toContain('accent-accent');
  });
  it('is transparent with a visible border unticked, accent when ticked', () => {
    expect(css).toMatch(/\.trove-check \{[^}]*appearance: none[^}]*background-color: transparent/s);
    expect(css).toMatch(/\.trove-check \{[^}]*border: 1px solid var\(--color-text-secondary\)/s);
    expect(css).toMatch(/\.trove-check:checked \{[^}]*background-color: var\(--color-accent\)/s);
  });
  it('has forced-colors overrides', () => {
    const fc = css.slice(css.indexOf('@media (forced-colors: active)'));
    expect(fc).toMatch(/\.trove-check:checked \{[^}]*Highlight/s);
  });
});
