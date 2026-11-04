import { flushSync } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ADDRESS_HISTORY_EVENT, isHistoryKey, useAddressBar } from './use-address-bar.svelte';
import { openPath, openUrl, readDir } from '$lib/api/fs';
import { actions } from '$lib/state/actions.svelte';
import { tabs } from '$lib/state/tabs.svelte';
import { pathLocation } from '$lib/utils/location';

vi.mock('$lib/api/shell', () => ({
  drives: vi.fn(async () => []),
  knownFolders: vi.fn(async () => []),
  userProfile: vi.fn(async () => 'C:\\Users\\alex'),
  oneDriveRoot: vi.fn(async () => null),
  openTerminal: vi.fn(async () => undefined),
}));
vi.mock('$lib/api/fs', () => ({
  readDir: vi.fn(async (path: string) => ({ path, entries: [] })),
  pathKind: vi.fn(async () => 'dir'),
  openPath: vi.fn(async () => undefined),
  openUrl: vi.fn(async () => undefined),
}));

const START = pathLocation('C:\\Users\\alex\\Documents');

const typeInAddressBar = async (text: string) => {
  const address = useAddressBar();
  address.startEdit();
  address.draft = text;
  await address.commit();
  flushSync();
  return address;
};

describe('a link typed in the address bar opens in the browser, as Explorer does', () => {
  beforeEach(async () => {
    await tabs.active.navigate(START, { replace: true });
    flushSync();
    vi.mocked(openUrl).mockClear();
    vi.mocked(openPath).mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('https://… goes to openUrl and the tab stays where it was', async () => {
    const address = await typeInAddressBar('https://example.com/a');
    expect(openUrl).toHaveBeenCalledWith('https://example.com/a');
    expect(tabs.active.location).toEqual(START);
    expect(address.editing).toBe(false);
  });

  it('http, ftp and mailto links go to the browser too', async () => {
    for (const url of ['http://example.com', 'ftp://example.com/x', 'mailto:alex@example.com']) {
      await typeInAddressBar(url);
      expect(openUrl).toHaveBeenLastCalledWith(url);
    }
    expect(tabs.active.location).toEqual(START);
  });

  it('another scheme is refused with a notice: no browser, no navigation', async () => {
    const notify = vi.spyOn(actions, 'notify');
    await typeInAddressBar('ssh://example.com');
    expect(openUrl).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('ssh'), 'error');
    expect(tabs.active.location).toEqual(START);
  });

  it('a browser failure is a notice, and the tab stays', async () => {
    vi.mocked(openUrl).mockRejectedValueOnce('no browser');
    const notify = vi.spyOn(actions, 'notify');
    await typeInAddressBar('https://example.com/a');
    expect(notify).toHaveBeenCalledWith('no browser', 'error');
    expect(tabs.active.location).toEqual(START);
  });

  it('file:///C:/… opens the folder in Trove, not the browser', async () => {
    await typeInAddressBar('file:///C:/Users/alex/a%20b');
    expect(openUrl).not.toHaveBeenCalled();
    expect(tabs.active.location).toEqual(pathLocation('C:\\Users\\alex\\a b'));
  });

  it('a WSL path and a drive path still navigate', async () => {
    await typeInAddressBar('Ubuntu:/home/a');
    expect(tabs.active.location).toEqual(pathLocation('\\\\wsl.localhost\\Ubuntu\\home\\a'));
    await typeInAddressBar('C:\\a');
    expect(tabs.active.location).toEqual(pathLocation('C:\\a'));
    expect(openUrl).not.toHaveBeenCalled();
  });
});

describe('the ▾ list: places this tab has been, newest first', () => {
  const A = { kind: 'path', path: String.raw`C:\a` } as const;
  const B = { kind: 'path', path: String.raw`C:\b` } as const;
  const C = { kind: 'path', path: String.raw`C:\c` } as const;
  const labels = (address: ReturnType<typeof useAddressBar>) =>
    address.historyItems.map((i) => (i.kind === 'item' ? i.label : i.key));

  it('lists where the tab went before, not where it is', async () => {
    await tabs.active.navigate(A, { replace: true });
    await tabs.active.navigate(B);
    await tabs.active.navigate(C);
    flushSync();
    const address = useAddressBar();
    expect(labels(address).slice(0, 2)).toEqual([B.path, A.path]);
    expect(labels(address)).not.toContain(C.path);
  });

  it('after Back the place left behind comes first', async () => {
    await tabs.active.navigate(A, { replace: true });
    await tabs.active.navigate(B);
    await tabs.active.navigate(C);
    await tabs.active.back();
    flushSync();
    expect(labels(useAddressBar()).slice(0, 2)).toEqual([C.path, A.path]);
  });

  it('picking a row goes there', async () => {
    await tabs.active.navigate(A, { replace: true });
    await tabs.active.navigate(B);
    flushSync();
    const row = useAddressBar().historyItems.find((i) => i.kind === 'item' && i.label === A.path);
    expect(row?.kind).toBe('item');
    if (row?.kind === 'item') await row.run();
    flushSync();
    expect(tabs.active.location).toEqual(A);
  });

  it('Alt+↓ and F4 open it; Alt+F4 (close the window) and a plain ↓ do not', () => {
    const k = (key: string, mods: Partial<KeyboardEvent> = {}) => ({
      key,
      altKey: false,
      ctrlKey: false,
      shiftKey: false,
      ...mods,
    });
    expect(isHistoryKey(k('ArrowDown', { altKey: true }))).toBe(true);
    expect(isHistoryKey(k('F4'))).toBe(true);
    expect(isHistoryKey(k('F4', { altKey: true }))).toBe(false);
    expect(isHistoryKey(k('ArrowDown'))).toBe(false);
    expect(isHistoryKey(k('ArrowDown', { altKey: true, ctrlKey: true }))).toBe(false);
  });

  it('the window F4 event opens the menu under the bar, and a second one closes it', () => {
    const address = useAddressBar();
    // no DOM here: the bar is an EventTarget with the two things the menu reads off it
    const bar = Object.assign(new EventTarget(), {
      getBoundingClientRect: () => ({ left: 10, bottom: 40 }),
      focus: () => undefined,
    }) as unknown as HTMLElement;
    const detach = address.historyTarget(bar);
    bar.dispatchEvent(new CustomEvent(ADDRESS_HISTORY_EVENT));
    expect(address.historyMenu.open).toBe(true);
    bar.dispatchEvent(new CustomEvent(ADDRESS_HISTORY_EVENT));
    expect(address.historyMenu.open).toBe(false);
    if (typeof detach === 'function') detach();
  });
});

describe("the chevron after a crumb lists that folder's subfolders (plan 06 § 6.4)", () => {
  const anchor = {
    getBoundingClientRect: () => ({ left: 10, bottom: 40 }),
    focus: () => undefined,
  } as unknown as HTMLElement;
  const dir = (name: string) => ({
    name,
    path: `C:\\Users\\alex\\${name}`,
    isDir: true,
    size: 0,
    modifiedMs: null,
    createdMs: null,
    ext: null,
    isHidden: false,
    iconKey: 'folder',
    typeName: 'File folder',
  });

  beforeEach(async () => {
    await tabs.active.navigate(START, { replace: true });
    flushSync();
  });

  const lastCrumb = (a: ReturnType<typeof useAddressBar>) => a.crumbs.length - 1;

  it('opens with the folders, and picking one navigates there', async () => {
    vi.mocked(readDir).mockResolvedValueOnce({ path: '', entries: [dir('b'), dir('a')] });
    const address = useAddressBar();
    await address.openCrumbMenu(lastCrumb(address), anchor);
    expect(address.crumbMenu.open).toBe(true);
    expect(address.crumbItems.map((r) => r.key)).toEqual([
      'C:\\Users\\alex\\a',
      'C:\\Users\\alex\\b',
    ]);
    const row = address.crumbItems[0];
    if (row?.kind === 'item') await row.run();
    flushSync();
    expect(tabs.active.location).toEqual(pathLocation('C:\\Users\\alex\\a'));
  });

  it('a folder that cannot be read opens one quiet disabled row, and does not throw', async () => {
    vi.mocked(readDir).mockRejectedValueOnce('denied');
    const address = useAddressBar();
    await address.openCrumbMenu(lastCrumb(address), anchor);
    expect(address.crumbMenu.open).toBe(true);
    expect(address.crumbItems.map((r) => r.key)).toEqual(['none']);
  });

  it('a second press on the same chevron closes it; Escape-style close() too', async () => {
    const address = useAddressBar();
    const i = lastCrumb(address);
    await address.openCrumbMenu(i, anchor);
    expect(address.crumbMenuOf).toBe(i);
    await address.openCrumbMenu(i, anchor);
    expect(address.crumbMenu.open).toBe(false);
    expect(address.crumbMenuOf).toBeNull();
  });
});
