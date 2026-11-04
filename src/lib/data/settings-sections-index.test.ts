import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$lib/api/index-settings', () => ({
  indexDrives: vi.fn(async () => [{ root: 'C:\\' }, { root: 'D:\\' }]),
  indexDiskSize: vi.fn(async () => 2048),
  indexForget: vi.fn(async () => 2048),
}));
vi.mock('$lib/api/default-handler', () => ({
  defaultHandlerStatus: vi.fn(async () => ({ kind: 'not-applied' })),
  defaultHandlerInfo: vi.fn(async () => ({ exePath: '', stable: true })),
  defaultHandlerApply: vi.fn(async () => {}),
  defaultHandlerRevert: vi.fn(async () => {}),
}));
vi.mock('$lib/api/shell-verbs', () => ({
  shellVerbs: vi.fn(async () => []),
  runShellVerb: vi.fn(async () => {}),
  runCustomCommand: vi.fn(async () => {}),
}));
vi.mock('$lib/api/palette', () => ({
  hidePalette: vi.fn(async () => {}),
  registerHotkey: vi.fn(async () => {}),
  onHotkeyFailed: vi.fn(),
  onSpotlightAction: vi.fn(),
  onSpotlightNavigate: vi.fn(),
  onSpotlightOpenFailed: vi.fn(),
  onSpotlightReveal: vi.fn(),
  onSpotlightSearch: vi.fn(),
}));

import { indexForget } from '$lib/api/index-settings';
import { confirm } from '$lib/state/confirm.svelte';
import { formatBytes, indexSettings } from '$lib/state/index-settings.svelte';
import { sanitize, settings } from '$lib/state/settings.svelte';
import {
  forgetIndex,
  indexBuiltInSkips,
  indexDriveText,
  settingsSections,
  type SettingRow,
} from './settings-sections';

const rows = (): SettingRow[] => settingsSections.find((s) => s.key === 'search-index')!.rows();
const row = (key: string): SettingRow => {
  const r = rows().find((x) => x.key === key);
  if (!r) throw new Error(`no row ${key}`);
  return r;
};

describe('search index settings', () => {
  beforeEach(async () => {
    settings.apply(sanitize(null));
    await indexSettings.refresh();
  });

  it('defaults: on, every drive on, nothing extra skipped', () => {
    const s = sanitize(null);
    expect(s.indexOn).toBe(true);
    expect(s.indexDrivesOff).toEqual([]);
    expect(s.indexSkipFolders).toEqual([]);
    // an old file without the keys keeps the defaults
    expect(sanitize({ view: 'details' }).indexOn).toBe(true);
  });

  it('bad stored values fall back; paths are trimmed and de-duplicated', () => {
    const s = sanitize({
      indexOn: 'x',
      indexDrivesOff: ['D:\\', 'd:\\', 4, ' '],
      indexSkipFolders: 'nope',
    });
    expect(s.indexOn).toBe(true);
    expect(s.indexDrivesOff).toEqual(['D:\\']);
    expect(s.indexSkipFolders).toEqual([]);
    expect(sanitize({ indexOn: false }).indexOn).toBe(false);
  });

  it('lists the on/off row, one row per drive, the skip list and Forget, in order', () => {
    expect(rows().map((r) => r.key)).toEqual([
      'index-on',
      'index-drive-c',
      'index-drive-d',
      'index-skip',
      'index-forget',
    ]);
  });

  it('a drive row turns that drive off and on in the setting', () => {
    const r = row('index-drive-d');
    if (r.kind !== 'toggle') throw new Error('toggle expected');
    expect(r.get()).toBe(true);
    r.set(false);
    expect(settings.indexDrivesOff).toEqual(['D:\\']);
    expect(r.get()).toBe(false);
    expect(row('index-drive-c')).toMatchObject({ kind: 'toggle' });
    r.set(true);
    expect(settings.indexDrivesOff).toEqual([]);
  });

  it('turning the index off greys the drive and skip rows', () => {
    settings.indexOn = false;
    expect(row('index-drive-c').disabled?.()).toBe(true);
    expect(row('index-skip').disabled?.()).toBe(true);
  });

  it('the skip list adds a full path, refuses a bad or repeated one, and removes', () => {
    const r = row('index-skip');
    if (r.kind !== 'folders') throw new Error('folders expected');
    expect(r.add('Games')).toMatch(/full folder path/);
    expect(r.add('C:\\Games\\')).toBeNull();
    expect(r.get()).toEqual(['C:\\Games']);
    expect(r.add('c:\\games')).toMatch(/already/);
    r.remove('C:\\Games');
    expect(r.get()).toEqual([]);
  });

  it('Forget asks first and does nothing on No', async () => {
    vi.mocked(indexForget).mockClear();
    const r = row('index-forget');
    if (r.kind !== 'button') throw new Error('button expected');
    const run = r.run() as Promise<boolean>;
    expect(confirm.pending?.danger).toBe(true);
    confirm.answer(false);
    expect(await run).toBe(false);
    expect(indexForget).not.toHaveBeenCalled();
  });

  it('Forget on Yes deletes the files and the size note goes to 0 B', async () => {
    const r = row('index-forget');
    if (r.kind !== 'button') throw new Error('button expected');
    expect(r.note?.()).toBe('Saved on disk: 2.0 KB');
    const run = r.run() as Promise<boolean>;
    confirm.answer(true);
    expect(await run).toBe(true);
    expect(indexForget).toHaveBeenCalledOnce();
    expect(r.note?.()).toBe('Saved on disk: 0 B');
    expect(r.disabled?.()).toBe(true);
  });

  it('the built-in skip list is the Windows one, or the Mac one with the Library junk', () => {
    expect(indexBuiltInSkips(false)).toEqual([
      'node_modules',
      '.git',
      '.pnpm-store',
      '.cargo\\registry',
      '.rustup',
      '__pycache__',
      '.next',
      '.turbo',
      '.gradle',
      'target (beside a Cargo.toml)',
      '$Recycle.Bin',
      'System Volume Information',
      'the temp folder',
    ]);
    const mac = indexBuiltInSkips(true);
    expect(mac).toContain('Library/Caches');
    expect(mac).toContain('.Trash');
    expect(mac).not.toContain('$Recycle.Bin');
    expect(mac).not.toContain('System Volume Information');
    // iCloud Drive and the cloud folders stay indexed
    expect(mac.some((s) => s.includes('Mobile Documents') || s.includes('CloudStorage'))).toBe(
      false,
    );
  });

  it('on Linux the built-in skip list is the Linux one, not the Windows one', () => {
    const linux = indexBuiltInSkips(false, true);
    for (const p of ['~/.cache', '~/.local/share/Trash', '/proc', '/sys', '/dev', '/run', '/media'])
      expect(linux).toContain(p);
    expect(linux).toContain('node_modules');
    expect(linux).not.toContain('$Recycle.Bin');
    expect(linux).not.toContain('System Volume Information');
    expect(linux).not.toContain('.Trash');
  });

  it("Linux's / row says it is outside home and walked every 30 minutes", () => {
    expect(indexDriveText('/', true)).toEqual({
      label: 'Outside the home folder (/)',
      description: 'Walked again every 30 minutes; USB drives and network shares are never indexed',
    });
    expect(indexDriveText('D:\\', false).label).toBe('Drive D:');
  });

  it('the Forget copy says this Mac on a Mac and this PC elsewhere', async () => {
    const ask = async (mac: boolean) => {
      const run = forgetIndex(mac);
      const message = confirm.pending?.message;
      confirm.answer(false);
      await run;
      return message;
    };
    expect(await ask(true)).toContain('this Mac');
    expect(await ask(false)).toContain('this PC');
  });

  it('formats sizes', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
  });
});
