import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => null) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock('$lib/api/recycle', () => ({
  recycleList: vi.fn(async () => []),
  recyclePurge: vi.fn(async () => {}),
  recycleRestore: vi.fn(async () => {}),
  recycleEmpty: vi.fn(async () => {}),
}));
vi.mock('$lib/api/gallery', () => ({ galleryItems: vi.fn(async () => []) }));
vi.mock('$lib/api/settings', () => ({
  readSettings: vi.fn(async () => null),
  writeSettings: vi.fn(async () => {}),
  emitSettingsChanged: vi.fn(async () => {}),
  onSettingsChanged: vi.fn(async () => () => {}),
}));

const { confirm } = await import('$lib/state/confirm.svelte');
const { recycle } = await import('$lib/state/recycle.svelte');
const { gallery, picturesGallery } = await import('$lib/state/gallery.svelte');
const { useRecycleView } = await import('./use-recycle-view.svelte');
const { useGalleryView } = await import('./use-gallery-view.svelte');

const press = (key: string) => {
  const e = {
    key,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    defaultPrevented: false,
    preventDefault() {
      e.defaultPrevented = true;
    },
    stopPropagation() {},
  };
  return e as unknown as KeyboardEvent & { defaultPrevented: boolean };
};

const ask = () =>
  void confirm.ask({ title: 'Empty?', message: '', okLabel: 'Delete', danger: true });

/** The Recycle Bin and Gallery views behind a dialog (Tests run on Svelte's server build). */
describe('the Recycle Bin and Gallery while a dialog is open', () => {
  afterEach(() => {
    confirm.answer(false);
    vi.restoreAllMocks();
  });

  it('Recycle Bin: F5 reloads with no dialog; behind one it is prevented and does nothing', () => {
    const reload = vi.spyOn(recycle, 'reload').mockResolvedValue(undefined as never);
    const view = useRecycleView();
    view.onkeydown(press('F5'));
    expect(reload).toHaveBeenCalledTimes(1);

    ask();
    const ev = press('F5');
    view.onkeydown(ev);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(ev.defaultPrevented).toBe(true);
  });

  it('Gallery: F5 behind a dialog is prevented and does not reload', () => {
    const reload = vi.spyOn(gallery, 'reload').mockResolvedValue(undefined as never);
    const view = useGalleryView(() => picturesGallery);
    ask();
    const ev = press('F5');
    view.onkeydown(ev);
    expect(ev.defaultPrevented).toBe(true);
    expect(reload).not.toHaveBeenCalled();
  });
});
