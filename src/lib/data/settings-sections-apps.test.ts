import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$lib/api/default-handler', () => ({
  defaultHandlerStatus: vi.fn(async () => ({ kind: 'not-applied' })),
  defaultHandlerInfo: vi.fn(async () => ({ exePath: 'x', stable: true })),
  defaultHandlerApply: vi.fn(async () => {}),
  defaultHandlerRevert: vi.fn(async () => {}),
}));
vi.mock('$lib/api/shell-verbs', () => ({
  shellVerbs: vi.fn(async () => []),
  runShellVerb: vi.fn(async () => {}),
  runCustomCommand: vi.fn(async () => {}),
  detectCommonCommands: vi.fn(async () => []),
  resolveCustomProgram: vi.fn(async () => null),
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
  spotlightApps: vi.fn(async () => []),
}));

import { detectCommonCommands } from '$lib/api/shell-verbs';
import { customize } from '$lib/state/customize.svelte';
import { settingsDialog, type SettingsSectionKey } from '$lib/state/settings-dialog.svelte';
import { settings } from '$lib/state/settings.svelte';
import type { DetectedApp } from '$lib/types/shell-verbs';
import { DETECT_EVIDENCE } from './detect-evidence';
import { settingsSections } from './settings-sections';

const app = (over: Partial<DetectedApp> = {}): DetectedApp => ({
  id: 'detected-code',
  label: 'Open with Code',
  program: 'C:\\Apps\\Code\\Code.exe',
  args: '%path%',
  scope: ['file', 'folder'],
  source: 'app-paths',
  certain: true,
  ...over,
});

const apps = () => settingsSections.find((s) => s.key === 'apps')!;
const rows = () => apps().rows();
const toggle = (key: string) => {
  const r = rows().find((x) => x.key === key);
  if (!r || r.kind !== 'toggle') throw new Error(`no toggle ${key}`);
  return r;
};

beforeEach(() => {
  settings.customCommands = [];
  customize.detected = null;
  customize.detecting = false;
});

describe('Settings "Apps" section (plan 07 E.3 / E.4a)', () => {
  it('is a real section key, so settings-dialog.show() can take it', () => {
    const key: SettingsSectionKey = 'apps';
    settingsDialog.section = key;
    expect(settingsSections.some((s) => s.key === key)).toBe(true);
  });

  it('has one toggle per detected entry, plus the Scan button', () => {
    customize.detected = [app(), app({ id: 'detected-zed', label: 'Open with Zed' })];
    expect(rows().map((r) => `${r.kind}:${r.key}`)).toEqual([
      'button:scan-apps',
      'toggle:app-detected-code',
      'toggle:app-detected-zed',
    ]);
  });

  it('says how each was found, from the shared map, and flags a guess', () => {
    customize.detected = [app(), app({ id: 'w', source: 'wsl-distro', certain: false })];
    expect(toggle('app-detected-code').note?.()).toBe(DETECT_EVIDENCE['app-paths']);
    expect(toggle('app-w').note?.()).toContain(DETECT_EVIDENCE['wsl-distro']);
    expect(toggle('app-w').note?.()).toContain('a guess');
  });

  it('keeps description for what it does, evidence in note', () => {
    customize.detected = [app()];
    const t = toggle('app-detected-code');
    expect(t.description).not.toContain(DETECT_EVIDENCE['app-paths']);
    expect(t.note?.()).toBe(DETECT_EVIDENCE['app-paths']);
  });

  it('opening the section changes nothing and never scans', () => {
    customize.detected = [app()];
    settings.customCommands = [
      { id: 'mine', label: 'Mine', program: 'zed', args: '%path%', scope: ['file'] },
    ];
    const snap = () =>
      JSON.stringify([customize.detected, settings.customCommands, customize.detecting]);
    const before = snap();
    settingsDialog.section = 'apps';
    rows().forEach((r) => {
      if (r.kind === 'toggle') r.get();
      r.note?.();
    });
    expect(snap()).toBe(before);
    expect(detectCommonCommands).not.toHaveBeenCalled();
  });

  it('with nothing scanned yet it lists only the Scan button and adds nothing', () => {
    expect(rows().map((r) => r.key)).toEqual(['scan-apps']);
    expect(rows()[0].note?.()).toBe('Not scanned yet');
    expect(settings.customCommands).toEqual([]);
  });

  it('toggle on then off round-trips back to the exact starting list', () => {
    customize.detected = [app()];
    const start = JSON.stringify(settings.customCommands);
    const t = toggle('app-detected-code');
    expect(t.get()).toBe(false);
    t.set(true);
    expect(t.get()).toBe(true);
    expect(settings.customCommands.map((c) => c.id)).toEqual(['detected-code']);
    t.set(false);
    expect(t.get()).toBe(false);
    expect(JSON.stringify(settings.customCommands)).toBe(start);
  });

  it('writes through addDetected', () => {
    customize.detected = [app()];
    const spy = vi.spyOn(customize, 'addDetected');
    toggle('app-detected-code').set(true);
    expect(spy).toHaveBeenCalledWith(customize.detected[0]);
    spy.mockRestore();
  });

  it('reads ON for a hand-typed twin with a random id (sameCommand, not id)', () => {
    customize.detected = [app({ program: 'C:\\Apps\\Code\\Code.exe' })];
    settings.customCommands = [
      {
        id: 'cmd-random1',
        label: 'My Code',
        program: 'code',
        args: '%path%',
        scope: ['folder', 'file'],
      },
    ];
    expect(toggle('app-detected-code').get()).toBe(true);
  });

  it('a hand-typed twin survives toggle off, still reads ON, and the row is locked with a note', () => {
    customize.detected = [app()];
    const mine = {
      id: 'cmd-random1',
      label: 'My Code',
      program: 'code',
      args: '%path%',
      scope: ['folder', 'file'] as ('file' | 'folder')[],
    };
    settings.customCommands = [mine];
    const t = toggle('app-detected-code');
    expect(t.disabled?.()).toBe(true);
    expect(t.note?.()).toContain('remove it in Customize');
    t.set(false);
    expect(settings.customCommands).toEqual([mine]);
    expect(t.get()).toBe(true);
  });

  it('with both a detected entry and a typed twin, off removes only the detected one', () => {
    customize.detected = [app()];
    const mine = {
      id: 'cmd-r',
      label: 'm',
      program: 'code',
      args: '%path%',
      scope: ['file', 'folder'] as ('file' | 'folder')[],
    };
    settings.customCommands = [mine];
    customize.addDetected(customize.detected[0]);
    customize.removeDetected(customize.detected[0]);
    expect(settings.customCommands).toEqual([mine]);
  });

  it('an app added from detection is not locked', () => {
    customize.detected = [app()];
    const t = toggle('app-detected-code');
    t.set(true);
    expect(t.disabled?.()).toBe(false);
  });

  it('a same-program command scoped differently is not the same: reads off', () => {
    customize.detected = [app()];
    settings.customCommands = [
      { id: 'cmd-x', label: 'x', program: 'code', args: '%path%', scope: ['file'] },
    ];
    expect(toggle('app-detected-code').get()).toBe(false);
  });

  it('toggling off leaves unrelated commands alone', () => {
    customize.detected = [app()];
    settings.customCommands = [
      { id: 'other', label: 'o', program: 'vim', args: '%path%', scope: ['file'] },
    ];
    const t = toggle('app-detected-code');
    t.set(true);
    t.set(false);
    expect(settings.customCommands.map((c) => c.id)).toEqual(['other']);
  });

  it('Scan is the only thing that reads the machine, and it only fills the store', async () => {
    vi.mocked(detectCommonCommands).mockResolvedValueOnce([app()]);
    const scan = rows()[0];
    if (scan.kind !== 'button') throw new Error('not a button');
    await scan.run();
    expect(customize.detected).toHaveLength(1);
    expect(settings.customCommands).toEqual([]);
  });
});
