import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultHandler, UNSTABLE_WARNING } from './default-handler.svelte';
import { settings } from './settings.svelte';
import { notices } from './notices.svelte';
import {
  defaultHandlerApply,
  defaultHandlerInfo,
  defaultHandlerRevert,
  defaultHandlerStatus,
} from '$lib/api/default-handler';

vi.mock('$lib/api/default-handler', () => ({
  defaultHandlerStatus: vi.fn(async () => ({ kind: 'not-applied' })),
  defaultHandlerInfo: vi.fn(async () => ({ exePath: 'D:\\apps\\explorer.exe', stable: true })),
  defaultHandlerApply: vi.fn(async () => {}),
  defaultHandlerRevert: vi.fn(async () => {}),
}));

const EXE = 'D:\\apps\\explorer.exe';
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('defaultHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // `clearAllMocks` keeps implementations: without these, the rejection and the delays the
    // tests below install would leak into every test after them
    vi.mocked(defaultHandlerStatus).mockResolvedValue({ kind: 'not-applied' });
    vi.mocked(defaultHandlerInfo).mockResolvedValue({ exePath: EXE, stable: true });
    vi.mocked(defaultHandlerApply).mockResolvedValue(undefined);
    vi.mocked(defaultHandlerRevert).mockResolvedValue(undefined);
    settings.defaultHandler = { applied: false, exePath: '' };
    defaultHandler.status = null;
    defaultHandler.info = null;
    notices.clear();
  });

  it('load fills the status and the exe info', async () => {
    await defaultHandler.load();
    expect(defaultHandler.status).toEqual({ kind: 'not-applied' });
    expect(defaultHandler.info).toEqual({ exePath: EXE, stable: true });
    expect(defaultHandler.isDefault).toBe(false);
    expect(defaultHandler.checked).toBe(false);
    expect(defaultHandler.warning).toBeNull();
  });

  it('toggle applies when not applied, records the exe in settings and says so', async () => {
    await defaultHandler.load();
    vi.mocked(defaultHandlerStatus).mockResolvedValue({ kind: 'applied' });
    await defaultHandler.toggle();
    expect(defaultHandlerApply).toHaveBeenCalledTimes(1);
    expect(defaultHandlerRevert).not.toHaveBeenCalled();
    expect(settings.defaultHandler).toEqual({ applied: true, exePath: EXE });
    expect(notices.list.at(-1)).toMatchObject({ kind: 'success' });
    expect(notices.list.at(-1)?.title).toMatch(/default file manager/);
    expect(notices.list.at(-1)?.action?.label).toBe('Undo');
    expect(defaultHandler.isDefault).toBe(true);
    expect(defaultHandler.needsReapply).toBe(false);
  });

  it('toggle reverts when applied and forgets the exe', async () => {
    vi.mocked(defaultHandlerStatus).mockResolvedValue({ kind: 'applied' });
    settings.defaultHandler = { applied: true, exePath: EXE };
    await defaultHandler.load();
    expect(defaultHandler.checked).toBe(true);
    vi.mocked(defaultHandlerStatus).mockResolvedValue({ kind: 'not-applied' });
    await defaultHandler.toggle();
    expect(defaultHandlerRevert).toHaveBeenCalledTimes(1);
    expect(defaultHandlerApply).not.toHaveBeenCalled();
    expect(settings.defaultHandler).toEqual({ applied: false, exePath: '' });
    expect(notices.list.at(-1)).toMatchObject({
      kind: 'info',
      message: 'Explorer is the default file manager again',
    });
  });

  it('an exe in a temporary folder warns and is not applied', async () => {
    vi.mocked(defaultHandlerInfo).mockResolvedValue({
      exePath: 'C:\\Users\\alex\\AppData\\Local\\Temp\\explorer.exe',
      stable: false,
    });
    await defaultHandler.load();
    expect(defaultHandler.warning).toBe(UNSTABLE_WARNING);
    await defaultHandler.toggle();
    expect(defaultHandlerApply).not.toHaveBeenCalled();
    expect(notices.list.at(-1)).toMatchObject({ kind: 'warning', message: UNSTABLE_WARNING });
    expect(settings.defaultHandler.applied).toBe(false);
  });

  it('a failed apply shows the message and leaves settings alone', async () => {
    vi.mocked(defaultHandlerApply).mockRejectedValue('Access is denied');
    await defaultHandler.load();
    await defaultHandler.toggle();
    expect(notices.list.at(-1)).toMatchObject({ kind: 'error', message: 'Access is denied' });
    expect(settings.defaultHandler.applied).toBe(false);
    expect(defaultHandler.busy).toBe(false);
  });

  it('needsReapply when settings say applied but the registry does not', async () => {
    settings.defaultHandler = { applied: true, exePath: EXE };
    vi.mocked(defaultHandlerStatus).mockResolvedValue({
      kind: 'applied-to-other',
      exe: 'E:\\old\\explorer.exe',
    });
    await defaultHandler.load();
    expect(defaultHandler.needsReapply).toBe(true);
    expect(defaultHandler.movedTo).toBeNull();
    expect(defaultHandler.reapplyText).toMatch(/Windows reset/);
  });

  // `busy` is lowered before the load in `apply`/`revert`'s `finally`, so a second toggle starts
  // while the first's registry read is still in flight. Two reads do not answer in the order they
  // were asked, and the older one describes the keys as they were *before* the newer write.
  it('a load overtaken by a newer one writes nothing, so no stale reading lands', async () => {
    settings.defaultHandler = { applied: true, exePath: EXE };
    vi.mocked(defaultHandlerStatus)
      .mockImplementationOnce(async () => {
        await delay(20);
        return { kind: 'not-applied' };
      })
      .mockImplementationOnce(async () => ({ kind: 'applied' }));
    const first = defaultHandler.load();
    const second = defaultHandler.load();
    await Promise.all([first, second]);
    expect(defaultHandler.status).toEqual({ kind: 'applied' });
    // ⭐ the false claims: the switch flipping itself back off, and a "Windows reset the default
    // file manager" offer raised off a reading taken before the keys were written
    expect(defaultHandler.checked).toBe(true);
    expect(defaultHandler.needsReapply).toBe(false);
  });

  // ⭐ `apply` writes the keys, remembers in settings that it did, and only then re-reads the
  // registry. The shell hook raises the Re-apply toast the instant `needsReapply` turns true, so
  // it must not be true anywhere in that window — the old reading is ours, not a Windows reset.
  it('needsReapply stays false across an apply, never off the pre-apply reading', async () => {
    await defaultHandler.load();
    expect(defaultHandler.needsReapply).toBe(false);
    // the keys read back as ours, but a registry read is not instant
    vi.mocked(defaultHandlerStatus).mockImplementation(async () => {
      await delay(10);
      return { kind: 'applied' };
    });
    const applying = defaultHandler.apply();
    const seen: boolean[] = [];
    for (let i = 0; i < 10; i++) {
      await delay(2);
      seen.push(defaultHandler.needsReapply);
    }
    await applying;
    expect(seen.filter(Boolean)).toEqual([]);
    expect(settings.defaultHandler).toEqual({ applied: true, exePath: EXE });
    expect(defaultHandler.needsReapply).toBe(false);
    expect(defaultHandler.checked).toBe(true);
  });

  // The honest state on this machine: settings say we applied it, the registry says otherwise,
  // and a reading taken *after* our last write is real evidence — the offer must still be made.
  it('a genuine reset is still reported once the registry has been read back', async () => {
    settings.defaultHandler = { applied: true, exePath: EXE };
    vi.mocked(defaultHandlerStatus).mockResolvedValue({ kind: 'not-applied' });
    await defaultHandler.revert();
    settings.defaultHandler = { applied: true, exePath: EXE };
    await defaultHandler.load();
    expect(defaultHandler.needsReapply).toBe(true);
    expect(defaultHandler.checked).toBe(false);
  });

  it('a moved exe is reported as such, and an applied registry needs nothing', async () => {
    settings.defaultHandler = { applied: true, exePath: 'E:\\old\\explorer.exe' };
    vi.mocked(defaultHandlerStatus).mockResolvedValue({ kind: 'not-applied' });
    await defaultHandler.load();
    expect(defaultHandler.movedTo).toBe(EXE);
    expect(defaultHandler.reapplyText).toMatch(/moved/);

    vi.mocked(defaultHandlerStatus).mockResolvedValue({ kind: 'applied' });
    await defaultHandler.load();
    expect(defaultHandler.needsReapply).toBe(false);
  });
});
