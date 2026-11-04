import { describe, expect, it } from 'vitest';
import { PaletteSettings } from './palette-settings';
import { sanitize, type Settings } from './settings.svelte';

type Fake = Settings & { settled: boolean; snapshot(): Settings };

// A stand-in for `settings`: its fields, a snapshot of them, and `settled`.
const fakeSettings = (start: Partial<Settings> = {}): Fake => {
  const t = { ...sanitize(start), settled: false } as Fake;
  t.snapshot = () => {
    const rest: Record<string, unknown> = { ...t };
    delete rest.settled;
    delete rest.snapshot;
    return structuredClone(rest) as unknown as Settings;
  };
  return t;
};

const file = (fields: Partial<Settings>) => ({ ...sanitize({}), ...fields });

describe('PaletteSettings', () => {
  it('applies a change heard while hidden, at once', () => {
    const s = fakeSettings({ theme: 'light' });
    const sync = new PaletteSettings(s);
    sync.live({ theme: 'dark' });
    expect(s.theme).toBe('dark');
    expect(s.settled).toBe(true);
  });

  it('takes tab sets (M8) and rebinds (M7) from the explorer live, and keeps them over a stale file', () => {
    const s = fakeSettings();
    const sync = new PaletteSettings(s);
    const set = { name: 'Trove work', tabs: ['/Users/alex/a'], active: 0, savedAt: 1 };
    // "Save tabs as…" and a rebind in the main window: its settings:changed patch
    sync.live({ tabSets: [set], shortcutOverrides: { 'open-home': 'Ctrl+Alt+J' } });
    expect(s.tabSets).toEqual([set]);
    expect(s.shortcutOverrides).toEqual({ 'open-home': 'Ctrl+Alt+J' });
    // Spotlight shown before the explorer's 400 ms save: the file has neither yet
    sync.beginRead()(file({}));
    expect(s.tabSets).toEqual([set]);
    expect(s.shortcutOverrides).toEqual({ 'open-home': 'Ctrl+Alt+J' });
    // the file catches up: released; a later delete still arrives live
    sync.beginRead()(file({ tabSets: [set], shortcutOverrides: { 'open-home': 'Ctrl+Alt+J' } }));
    expect(sync.held).toEqual([]);
    sync.live({ tabSets: [] });
    expect(s.tabSets).toEqual([]);
  });

  it('ignores a stale file read after a newer live change (the 400 ms save delay)', () => {
    const s = fakeSettings({ theme: 'light' });
    const sync = new PaletteSettings(s);
    sync.live({ theme: 'dark' });
    // shown before the explorer saved: the file still says light
    sync.beginRead()(file({ theme: 'light', pins: ['C:\\new'] }));
    expect(s.theme).toBe('dark');
    // the rest of the file still lands
    expect(s.pins).toEqual(['C:\\new']);
    expect(sync.held).toEqual(['theme']);
  });

  it('lets the file win again once it has caught up', () => {
    const s = fakeSettings({ theme: 'light' });
    const sync = new PaletteSettings(s);
    sync.live({ theme: 'dark' });
    sync.beginRead()(file({ theme: 'dark' }));
    expect(sync.held).toEqual([]);
    // a later file value is now the newest thing known
    sync.beginRead()(file({ theme: 'light' }));
    expect(s.theme).toBe('light');
  });

  it('drops a read that finishes after a later read already applied', () => {
    const s = fakeSettings();
    const sync = new PaletteSettings(s);
    const older = sync.beginRead();
    const newer = sync.beginRead();
    newer(file({ theme: 'dark' }));
    older(file({ theme: 'light' }));
    expect(s.theme).toBe('dark');
  });

  it('sanitizes a live patch and ignores unknown keys or junk', () => {
    const s = fakeSettings({ theme: 'light' });
    const sync = new PaletteSettings(s);
    sync.live({ theme: 'purple', nope: 1 });
    sync.live(null);
    sync.live({});
    expect(s.theme).toBe('system');
    expect((s as unknown as Record<string, unknown>).nope).toBeUndefined();
    expect(sync.held).toEqual(['theme']);
  });

  it('is settled by a file read too', () => {
    const s = fakeSettings();
    new PaletteSettings(s).beginRead()(file({ theme: 'dark' }));
    expect(s.theme).toBe('dark');
    expect(s.settled).toBe(true);
  });
});
