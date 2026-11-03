import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync('src/app.css', 'utf8');

/** the body of the first `@media (<query>) { ... }` block, found by brace matching */
function block(query: string): string {
  const start = css.indexOf(`@media (${query})`);
  expect(start, `@media (${query}) exists`).toBeGreaterThan(-1);
  const open = css.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === '{') depth++;
    if (css[i] === '}' && --depth === 0) return css.slice(open + 1, i);
  }
  throw new Error('unbalanced block');
}

describe('reduced motion', () => {
  const b = block('prefers-reduced-motion: reduce');
  it('zeroes animation and transition durations for everything', () => {
    expect(b).toMatch(/animation-duration:\s*0\.01ms !important/);
    expect(b).toMatch(/transition-duration:\s*0\.01ms !important/);
  });
  it('shows spinners and pulses still instead of frozen mid-loop', () => {
    expect(b).toMatch(/\.animate-spin[^{]*\{[^}]*animation:\s*none !important/);
  });
  // E.6.6: WebKitGTK re-applies the media query only on a resize, so Linux writes the live
  // answer on <html> (core/reduced_motion.rs) and the media query must step aside once it does
  it('lets the media query apply only while <html> has no data-reduced-motion', () => {
    const sels = [...b.matchAll(/([^{}]+)\{/g)].map((m) => m[1]);
    expect(sels.length).toBeGreaterThan(0);
    for (const sel of sels) {
      for (const part of sel.split(',')) {
        expect(part.trim()).toMatch(/^:where\(:root:not\(\[data-reduced-motion\]\)\)/);
      }
    }
  });
  it('applies the same rules when <html data-reduced-motion="reduce">, outside any media query', () => {
    const attr = ":where(:root[data-reduced-motion='reduce'])";
    const at = css.indexOf(`${attr} *,`);
    expect(at).toBeGreaterThan(-1);
    const rule = css.slice(at, css.indexOf('}', at));
    expect(rule).toMatch(/animation-duration:\s*0\.01ms !important/);
    expect(rule).toMatch(/transition-duration:\s*0\.01ms !important/);
    expect(css).toContain(
      `${attr} .animate-spin,\n${attr} .animate-pulse {\n  animation: none !important;`,
    );
    // and it is not nested inside the media block, or it would go stale with it
    expect(b).not.toContain('data-reduced-motion=');
  });
  it('keeps the toast still under the attribute as well as the media query', () => {
    const toast = readFileSync('src/lib/components/shell/shell-parts/Toast.svelte', 'utf8');
    expect(toast).toMatch(
      /@media \(prefers-reduced-motion: reduce\) \{\s*:global\(:root:not\(\[data-reduced-motion\]\)\) \.toast \{\s*animation: none;/,
    );
    expect(toast).toMatch(
      /:global\(:root\[data-reduced-motion='reduce'\]\) \.toast \{\s*animation: none;/,
    );
  });
});

describe('forced colors', () => {
  const b = block('forced-colors: active');
  it('maps tokens to system colours', () => {
    for (const c of [
      'Canvas',
      'CanvasText',
      'Highlight',
      'HighlightText',
      'GrayText',
      'LinkText',
      'ButtonText',
    ]) {
      expect(b).toContain(c);
    }
    expect(b).toMatch(/--color-layer:\s*Canvas/);
  });
  it('makes body and Mac glass solid Canvas', () => {
    expect(b).toMatch(/body\s*\{[^}]*background:\s*Canvas/);
    expect(b).toMatch(/--glass-chrome:\s*Canvas/);
    expect(b).toMatch(/data-os='macos'\] \.rounded-window[^{]*\{[^}]*background:\s*Canvas/);
  });
  it('outlines selected rows and keeps focus rings', () => {
    expect(b).toMatch(/\[aria-selected='true'\]\s*\{[^}]*outline:[^;]*Highlight/);
    expect(b).toMatch(/:focus-visible[^{]*\{[^}]*outline:/);
  });
});

// G.72: the Mac twin of the forced-colors block, from src/styles/mac/contrast.css.
describe('mac increase contrast', () => {
  const mac = readFileSync('src/styles/mac/contrast.css', 'utf8');
  const start = mac.indexOf('@media (prefers-contrast: more)');
  const b = mac.slice(mac.indexOf('{', start) + 1);

  it('is imported by app.css, after the other Mac files', () => {
    expect(start).toBeGreaterThan(-1);
    const imports = [...css.matchAll(/@import '\.\/styles\/mac\/([a-z]+)\.css'/g)].map((m) => m[1]);
    expect(imports.at(-1)).toBe('contrast');
  });
  it('strengthens muted text, borders and dividers through the tokens', () => {
    expect(b).toMatch(/--color-text-secondary:\s*var\(--color-text\)/);
    expect(b).toMatch(/--color-divider:\s*var\(--color-text-secondary\)/);
    expect(b).toMatch(/--color-field-stroke:\s*var\(--color-text-secondary\)/);
    expect(b).toMatch(/--mac-hairline:\s*var\(--color-text-secondary\)/);
  });
  it('beats the dark token blocks in both themes', () => {
    expect(b).toMatch(/data-theme='light'\]/);
    expect(b).toMatch(/data-theme='dark'\] \.rounded-window/);
  });
  it('makes the focus ring a solid 3px outline', () => {
    expect(b).toMatch(/--mac-focus-ring:\s*-apple-system-control-accent/);
    expect(b).toMatch(/:focus-visible\s*\{[^}]*outline:\s*3px solid var\(--mac-focus-ring\)/);
  });
  it('outlines the selection and borders dialogs and menus', () => {
    expect(b).toMatch(/\[aria-selected='true'\][^{]*\{[^}]*outline:/);
    expect(b).toMatch(/\[role='menu'\][^{]*\{[^}]*border:/);
  });
});
