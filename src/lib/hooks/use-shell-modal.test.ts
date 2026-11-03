import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => null) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock('$lib/api/settings', () => ({
  readSettings: vi.fn(async () => null),
  writeSettings: vi.fn(async () => {}),
  emitSettingsChanged: vi.fn(async () => {}),
  onSettingsChanged: vi.fn(async () => () => {}),
}));

const { confirm } = await import('$lib/state/confirm.svelte');
const { tabs } = await import('$lib/state/tabs.svelte');
const { useShell } = await import('./use-shell.svelte');

const press = (key: string, ctrlKey = false) => {
  const e = {
    key,
    code: key.length === 1 ? `Key${key.toUpperCase()}` : key,
    ctrlKey,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    defaultPrevented: false,
    preventDefault() {
      e.defaultPrevented = true;
    },
  };
  return e as unknown as KeyboardEvent & { defaultPrevented: boolean };
};
/** Backspace is the window's Back: behind "Delete permanently?" it must not navigate away. */
const backspace = () => press('Backspace');

describe('window shortcuts while a dialog is open', () => {
  afterEach(() => {
    confirm.answer(false);
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('Backspace goes Back with no dialog, and does nothing behind one', () => {
    vi.stubGlobal('document', { activeElement: null });
    const back = vi.spyOn(tabs.active, 'back').mockImplementation(() => undefined as never);
    const shell = useShell();

    shell.onkeydown(backspace());
    expect(back).toHaveBeenCalledTimes(1);

    void confirm.ask({ title: 'Delete?', message: '', okLabel: 'Delete', danger: true });
    const ev = backspace();
    shell.onkeydown(ev);
    expect(back).toHaveBeenCalledTimes(1);
    // still prevented: the key is ours, and a skipped one would reach the WebView
    expect(ev.defaultPrevented).toBe(true);
  });

  it('Ctrl+R behind a dialog is prevented (no WebView reload) and does not refresh', () => {
    vi.stubGlobal('document', { activeElement: null });
    const refresh = vi.spyOn(tabs.active, 'refresh').mockResolvedValue(undefined as never);
    const shell = useShell();
    void confirm.ask({ title: 'Delete?', message: '', okLabel: 'Delete', danger: true });
    const ev = press('r', true);
    shell.onkeydown(ev);
    expect(ev.defaultPrevented).toBe(true);
    expect(refresh).not.toHaveBeenCalled();
  });

  it('a key no shortcut owns is left to the page, dialog or not', () => {
    vi.stubGlobal('document', { activeElement: null });
    const shell = useShell();
    void confirm.ask({ title: 'Delete?', message: '', okLabel: 'Delete', danger: true });
    const ev = press('Enter');
    shell.onkeydown(ev);
    expect(ev.defaultPrevented).toBe(false);
  });
});

describe('a lazy dialog whose chunk fails to load', () => {
  it('gives its question up, so the keys are not held by a dialog that never shows', async () => {
    const { modalOpen } = await import('$lib/state/modal.svelte');
    const shell = useShell();
    const answer = confirm.ask({ title: 'Delete?', message: '', okLabel: 'Delete', danger: true });
    expect(modalOpen()).toBe(true);
    const failed = shell.lazyDialog(Promise.reject(new Error('chunk')), shell.giveUp.confirm);
    await expect(failed).rejects.toThrow('chunk');
    expect(modalOpen()).toBe(false);
    await expect(answer).resolves.toBe(false);
  });
});

describe('mouse side buttons', () => {
  afterEach(() => {
    confirm.answer(false);
    vi.restoreAllMocks();
  });
  const click = (button: number) => ({ button }) as MouseEvent;

  it('button 3 is Back, 4 is Forward, others do nothing', () => {
    const back = vi.spyOn(tabs.active, 'back').mockImplementation(() => undefined as never);
    const fwd = vi.spyOn(tabs.active, 'forward').mockImplementation(() => undefined as never);
    const shell = useShell();
    shell.onmouseup(click(3));
    shell.onmouseup(click(4));
    shell.onmouseup(click(0));
    shell.onmouseup(click(1));
    expect(back).toHaveBeenCalledTimes(1);
    expect(fwd).toHaveBeenCalledTimes(1);
  });

  it('does nothing behind a dialog', () => {
    const back = vi.spyOn(tabs.active, 'back').mockImplementation(() => undefined as never);
    const shell = useShell();
    void confirm.ask({ title: 'Delete?', message: '', okLabel: 'Delete', danger: true });
    shell.onmouseup(click(3));
    expect(back).not.toHaveBeenCalled();
  });
});
