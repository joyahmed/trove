import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const stored = vi.hoisted(() => ({ value: null as unknown }));
vi.mock('$lib/api/settings', () => ({
  readSettings: vi.fn(async () => stored.value),
  writeSettings: vi.fn(async () => {}),
}));

import { settings } from './settings.svelte';

describe('custom command seeding', () => {
  beforeEach(() => {
    settings.loaded = false;
    settings.customCommands = [];
  });

  it('a first run gets the Code-over-WSL command', async () => {
    stored.value = null;
    await settings.load();
    expect(settings.customCommands.map((c) => c.label)).toEqual(['Open with Code (WSL)']);
  });

  it('a settings file written before the feature gets it too', async () => {
    stored.value = { view: 'details', pins: [] };
    await settings.load();
    expect(settings.customCommands).toHaveLength(1);
  });

  it('a file that holds an empty list stays empty — the person deleted it', async () => {
    stored.value = { view: 'details', customCommands: [] };
    await settings.load();
    expect(settings.customCommands).toHaveLength(0);
  });

  it('an old file with detected-id and hand-typed commands keeps every one, unchanged', async () => {
    const cmds = [
      {
        id: 'detected-code',
        label: 'Open with Code',
        program: 'code',
        args: '%path%',
        scope: ['file'],
      },
      { id: 'cmd-abc', label: 'Mine', program: 'code', args: '%path%', scope: ['file'] },
    ];
    stored.value = { view: 'details', customCommands: cmds };
    await settings.load();
    expect(settings.customCommands).toEqual(cmds);
  });
});

describe('custom command seeding off Windows', () => {
  beforeEach(() => {
    settings.loaded = false;
    settings.customCommands = [];
    vi.stubGlobal('window', { __TROVE_PLATFORM__: { os: 'macos', thisPcLabel: 'This Mac' } });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('a first run on a Mac gets no WSL command', async () => {
    stored.value = null;
    await settings.load();
    expect(settings.customCommands).toEqual([]);
  });

  it('a synced file keeps its WSL command stored', async () => {
    stored.value = {
      view: 'details',
      customCommands: [{ id: 'a', label: 'Code (WSL)', program: 'code', args: '', scope: ['wsl'] }],
    };
    await settings.load();
    expect(settings.customCommands).toHaveLength(1);
  });
});
