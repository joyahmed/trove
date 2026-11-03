import { beforeEach, describe, expect, it, vi } from 'vitest';
import { onTrayNewTab, setResident, setStartWithWindows } from '$lib/api/tray';
import { residency } from './residency.svelte';
import { settings } from './settings.svelte';
import { tabs } from './tabs.svelte';

let trayHandler: (() => void) | null = null;
vi.mock('$lib/api/tray', () => ({
  setResident: vi.fn(async () => {}),
  isResident: vi.fn(async () => false),
  setStartWithWindows: vi.fn(async () => {}),
  startWithWindows: vi.fn(async () => false),
  onTrayNewTab: vi.fn(async (cb: () => void) => {
    trayHandler = cb;
    return () => {};
  }),
}));

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('residency', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // `clearAllMocks` keeps implementations, and the overlap tests below install slow ones
    vi.mocked(setResident).mockImplementation(async () => {});
    vi.mocked(setStartWithWindows).mockImplementation(async () => {});
    settings.keepRunning = false;
    settings.startWithWindows = false;
    settings.defaultHandler = { applied: false, exePath: '' };
    residency.resident = null;
    residency.startWithWindows = null;
    while (tabs.list.length > 1) tabs.close(tabs.list.length - 1);
  });

  it('sync pushes the two settings once and again only when they change', async () => {
    await residency.sync();
    expect(setResident).toHaveBeenCalledWith(false);
    expect(setStartWithWindows).toHaveBeenCalledWith(false);
    settings.keepRunning = true;
    await residency.sync();
    expect(setResident).toHaveBeenLastCalledWith(true);
    expect(setStartWithWindows).toHaveBeenCalledTimes(1);
    await residency.sync();
    expect(setResident).toHaveBeenCalledTimes(2);
  });

  it('being the default file manager forces both on', async () => {
    settings.defaultHandler = { applied: true, exePath: 'D:\\a.exe' };
    expect(residency.wantsResident).toBe(true);
    expect(residency.wantsStartup).toBe(true);
    await residency.sync();
    expect(setResident).toHaveBeenCalledWith(true);
    expect(setStartWithWindows).toHaveBeenCalledWith(true);
  });

  // The shell's effect calls `sync` again whenever `keepRunning`, `startWithWindows` or the
  // default-handler toggle changes, and each push is an IPC round trip — so two syncs overlap on
  // an ordinary double toggle. The tray icon and the HKCU Run entry are one thing each: the
  // machine must be left the way the LAST caller asked, not the way whichever call finished last.
  it('overlapping syncs do not interleave: the last caller is what the machine is left holding', async () => {
    const calls: string[] = [];
    vi.mocked(setResident).mockImplementation(async (on: boolean) => {
      calls.push(`resident:${on}`);
      // turning it on is the slow one, so the older sync is the one that finishes last
      await delay(on ? 20 : 1);
    });
    vi.mocked(setStartWithWindows).mockImplementation(async (on: boolean) => {
      calls.push(`startup:${on}`);
    });
    settings.keepRunning = true;
    settings.startWithWindows = true;
    const first = residency.sync();
    await delay(0); // the first push is in flight, mid-IPC, when the person toggles again
    settings.keepRunning = false;
    settings.startWithWindows = false;
    const second = residency.sync();
    await Promise.all([first, second]);
    expect(calls).toEqual(['resident:true', 'startup:true', 'resident:false', 'startup:false']);
    expect(residency.resident).toBe(false);
    // ⭐ the false claim: Start-with-Windows left ON while the person had just turned it off —
    // and `sync` sends only what changed, so nothing would ever have corrected it
    expect(residency.startWithWindows).toBe(false);
  });

  it('an older sync cannot clear the failure the newest one has just reported', async () => {
    vi.mocked(setResident).mockImplementation(async (on: boolean) => {
      // the newest sync wants it on and Windows refuses; the older sync's push is the slow one
      if (on) throw 'Access is denied';
      await delay(20);
    });
    settings.keepRunning = false;
    const first = residency.sync();
    await delay(0); // in flight when the person turns it on
    settings.keepRunning = true;
    const second = residency.sync();
    await Promise.all([first, second]);
    expect(setResident).toHaveBeenCalledWith(true);
    // ⭐ the false claim: the app believes it is resident and has nothing to report, while the
    // person's last request failed
    expect(residency.error).toBe('Access is denied');
  });

  it("the tray's New tab opens a tab", async () => {
    const detach = residency.attach();
    await Promise.resolve();
    expect(onTrayNewTab).toHaveBeenCalled();
    const before = tabs.list.length;
    trayHandler?.();
    expect(tabs.list.length).toBe(before + 1);
    detach();
  });
});
