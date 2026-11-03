import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Plan 15 D.7 (Mac screen run 2026-10-21): WKWebView applies macOS autocorrect and
// auto-capitalisation to any text field that does not opt out, so typing `trovetest` in
// "Filter apps" became "Trove test" and `trovete` became "Trivet". Every Trove text field holds
// a name, path, filter, query or command, never prose, so every one must opt out. This scans the
// sources, so a new field without the attributes fails here.
const REQUIRED = [
  'autocorrect="off"',
  'autocapitalize="off"',
  'spellcheck="false"',
  'autocomplete="off"',
];

const svelteFiles = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return svelteFiles(path);
    return path.endsWith('.svelte') ? [path] : [];
  });

const files = svelteFiles('src');
const textFields = files.flatMap((file) => {
  const src = readFileSync(file, 'utf8');
  const tags = src.match(/<(input|textarea)\b[\s\S]*?>/g) ?? [];
  return tags
    .filter((tag) => !/type="(checkbox|radio|range|color|file|hidden|button|submit)"/.test(tag))
    .map((tag) => ({ file, tag }));
});

describe('text fields opt out of autocorrect', () => {
  it('finds the known text fields (the scan itself works)', () => {
    const names = textFields.map((f) => f.file);
    expect(names.some((n) => n.endsWith('ApplicationsView.svelte'))).toBe(true);
    expect(names.some((n) => n.endsWith('AddressBar.svelte'))).toBe(true);
    expect(names.some((n) => n.endsWith('RenameBox.svelte'))).toBe(true);
    expect(names.some((n) => n.endsWith('PaletteInput.svelte'))).toBe(true);
    expect(names.some((n) => n.endsWith('SearchBox.svelte'))).toBe(true);
    expect(textFields.length).toBeGreaterThanOrEqual(8);
  });

  it.each(REQUIRED)('every text field sets %s', (attr) => {
    const missing = textFields.filter((f) => !f.tag.includes(attr)).map((f) => f.file);
    expect(missing).toEqual([]);
  });

  it('no contenteditable region (it would need the same opt-out)', () => {
    const editable = files.filter((f) => /contenteditable/i.test(readFileSync(f, 'utf8')));
    expect(editable).toEqual([]);
  });
});
