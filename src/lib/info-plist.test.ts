import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const plist = readFileSync('src-tauri/Info.plist', 'utf8');

// G.68: macOS shows these strings in its "Trove would like to access..." prompts. Without them the
// prompt has no explanation text.
const USAGE_KEYS = [
  'NSDocumentsFolderUsageDescription',
  'NSDesktopFolderUsageDescription',
  'NSDownloadsFolderUsageDescription',
  'NSNetworkVolumesUsageDescription',
  'NSRemovableVolumesUsageDescription',
];

describe('Info.plist', () => {
  it('keeps the folder document type', () => {
    expect(plist).toContain('<key>CFBundleDocumentTypes</key>');
  });
  it.each(USAGE_KEYS)('%s is followed by a non-empty string', (key) => {
    expect(plist).toMatch(new RegExp(`<key>${key}</key>\\s*<string>[^<\\s][^<]*</string>`));
  });
  it('has balanced dict/array/string/key tags', () => {
    for (const tag of ['dict', 'array', 'string', 'key']) {
      const open = plist.match(new RegExp(`<${tag}>`, 'g'))?.length ?? 0;
      const close = plist.match(new RegExp(`</${tag}>`, 'g'))?.length ?? 0;
      expect(open).toBe(close);
    }
  });
});
