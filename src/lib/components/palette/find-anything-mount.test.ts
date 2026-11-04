import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// ⌘K sets `findAnything.open`; it only shows if <FindAnything /> is mounted. It used to live in
// SearchBox, which NavBar drops when the toolbar is narrow (`fit.collapsed('search')`): an 800 px
// window at a large text size (~520 CSS px) then had a ⌘K, and a "…" menu row, that did nothing.
const markup = (path: string) =>
  readFileSync(path, 'utf8')
    .replace(/<script[\s\S]*?<\/script>/g, '')
    .replace(/<!--[\s\S]*?-->/g, '');

describe('Find anything is mounted where a narrow toolbar cannot take it away', () => {
  it('Shell mounts it, outside every {#if}', () => {
    const shell = markup('src/lib/components/shell/Shell.svelte');
    const at = shell.indexOf('<FindAnything />');
    expect(at).toBeGreaterThan(-1);
    const before = shell.slice(0, at);
    const opened = (before.match(/\{#(if|each|await)\b/g) ?? []).length;
    const closed = (before.match(/\{\/(if|each|await)\}/g) ?? []).length;
    expect(opened).toBe(closed);
  });

  it('the collapsible search box no longer mounts a second one', () => {
    expect(markup('src/lib/components/nav/nav-parts/SearchBox.svelte')).not.toContain(
      '<FindAnything',
    );
    expect(markup('src/lib/components/nav/NavBar.svelte')).not.toContain('<FindAnything');
  });
});
