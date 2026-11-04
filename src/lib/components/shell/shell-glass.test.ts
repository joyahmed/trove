import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// app.css's Mac glass rules give every child of the shell's main row EXCEPT the first one (the
// sidebar, which shows the lighter chrome tint) the stronger content tint, and do the same for the
// body's later children except the status bar's `footer`. They key on position because PaneHost's
// root is an `aside` too. These pin the structure they assume.
const markup = (path: string) =>
  readFileSync(path, 'utf8')
    .replace(/<script[\s\S]*?<\/script>/g, '')
    .replace(/<!--[\s\S]*?-->/g, '');

describe('Shell structure the Mac glass CSS depends on', () => {
  it('Sidebar is the first element of the row inside the bg-layer body (behind the Navigation pane toggle)', () => {
    const shell = markup('src/lib/components/shell/Shell.svelte');
    const body = shell.indexOf('<div class="bg-layer');
    expect(body).toBeGreaterThan(-1);
    const afterBody = shell.slice(body + 1);
    const row = afterBody.slice(afterBody.indexOf('<div'));
    // the first tag or block after the row's opening tag
    const inner = row.slice(row.indexOf('>') + 1).trimStart();
    expect(inner).toMatch(/^\{#if shell\.navPane\}\s*<Sidebar \/>\s*\{\/if\}/);
  });

  it('Sidebar renders its root unconditionally and the root carries the data-mac the CSS skips', () => {
    const sidebar = markup('src/lib/components/sidebar/Sidebar.svelte').trimStart();
    expect(sidebar.startsWith('<aside')).toBe(true);
    expect(sidebar.slice(0, sidebar.indexOf('>'))).toContain('data-mac="sidebar"');
  });

  it('StatusBar is the last element of the body and its root is a footer', () => {
    const shell = markup('src/lib/components/shell/Shell.svelte');
    const body = shell.slice(shell.indexOf('<div class="bg-layer'));
    const close = body.indexOf('<Toasts />');
    expect(body.slice(0, close).trimEnd()).toMatch(/<StatusBar [^>]*\/>\s*<\/div>$/);
    const bar = markup('src/lib/components/shell/StatusBar.svelte').trimStart();
    expect(bar.startsWith('<footer')).toBe(true);
  });

  it('the CSS skips the sidebar by data-mac, not a tag or position, and tints the content surfaces', () => {
    const css = readFileSync('src/app.css', 'utf8');
    expect(css).toContain(
      ":root[data-os='macos'] .rounded-window > .bg-layer > :first-child > :not([data-mac='sidebar'])",
    );
    expect(css).toContain(
      ":root[data-os='macos'] .rounded-window > .bg-layer > :not(:first-child):not(footer)",
    );
    expect(css).not.toContain('> :not(aside)');
    // by position, a hidden navigation pane would leave the list untinted
    expect(css).not.toContain('> :first-child > :not(:first-child)');
    // no part of the shell row is filled with the SOLID layer on a Mac any more
    expect(css).not.toMatch(/data-os='macos'[^{]*\{\s*background-color: var\(--color-layer\)/);
  });
});

// base.css paints every text field inside a dialog as an NSTextField: a 22px WHITE well. The
// Spotlight / Find anything panel is a dialog too, and its search line is a borderless field on
// the glass, so it opts out by being `bg-transparent`. Without the opt-out it was a white strip.
describe('the palette search line stays see-through on a Mac', () => {
  const css = readFileSync('src/styles/mac/base.css', 'utf8');
  const fieldRule = (s: string) => {
    const start = s.indexOf('/* NSTextField');
    return s.slice(start, s.indexOf('{', s.indexOf(':root', start)));
  };

  it('the palette input is the dialog field that is bg-transparent', () => {
    const input = markup('src/lib/components/palette/palette-parts/PaletteInput.svelte');
    expect(input).toMatch(/<input\s+class="[^"]*\bbg-transparent\b/);
    expect(markup('src/lib/components/palette/Palette.svelte')).toContain('role="dialog"');
  });

  it('the white field well and its ring skip bg-transparent fields', () => {
    expect(fieldRule(css)).toContain(':not(.bg-transparent)');
    expect(css).toMatch(/textarea\):not\(\s*\.bg-transparent\s*\):focus \{/);
    expect(css).toMatch(/input\.bg-transparent:is\(:focus, :focus-visible\) \{\s*outline: none;/);
  });
});
