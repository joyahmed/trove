import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useDragGhost } from '$lib/hooks/use-drag-ghost.svelte';
import { AUTO_OPEN_MS, drag, effectFor, isNoOp, volumeOf, type DropTarget } from './drag.svelte';
import { selection } from './selection.svelte';
import { tabs } from './tabs.svelte';
import { transfers } from './transfers.svelte';
import { notices } from './notices.svelte';
import { settings } from './settings.svelte';
import type { FileEntry } from '$lib/types/fs';
import {
  dragOut,
  dropModifiers,
  sameVolume,
  startTransfer,
  transferConflicts,
} from '$lib/api/transfer';

vi.mock('$lib/api/transfer', () => ({
  startTransfer: vi.fn(async () => 1),
  cancelTransfer: vi.fn(async () => {}),
  transferConflicts: vi.fn(async () => []),
  onTransferProgress: vi.fn(async () => () => {}),
  onTransferDone: vi.fn(async () => () => {}),
  dragOut: vi.fn(async () => ({ effect: 'none' })),
  sameVolume: vi.fn(async () => true),
  dropModifiers: vi.fn(async () => ({ ctrl: false, shift: false })),
}));
vi.mock('$lib/api/clipboard', () => ({
  clipboardWritePaths: vi.fn(async () => {}),
  clipboardReadPaths: vi.fn(async () => null),
}));
vi.mock('$lib/api/fs', () => ({
  readDir: vi.fn(async (path: string) => ({ path, entries: [] })),
  trashEntries: vi.fn(async () => {}),
  pathKind: vi.fn(async (p: string) => (/\.\w+$/.test(p) ? 'file' : 'dir')),
}));
vi.mock('$lib/api/shell', () => ({
  drives: vi.fn(async () => []),
  knownFolders: vi.fn(async () => []),
}));

const row = (path: string): DropTarget => ({ path, kind: 'row', tab: null });
const A = 'D:\\src\\a.txt';
const B = 'D:\\src\\b.txt';

describe('effectFor and isNoOp', () => {
  it('moves on the same volume, copies across, and the modifiers override', () => {
    expect(effectFor([A], 'D:\\other', { ctrl: false, shift: false })).toBe('move');
    expect(effectFor([A], 'C:\\other', { ctrl: false, shift: false })).toBe('copy');
    expect(effectFor([A], 'D:\\other', { ctrl: true, shift: false })).toBe('copy');
    expect(effectFor([A], 'C:\\other', { ctrl: false, shift: true })).toBe('move');
    expect(
      effectFor(['\\\\wsl.localhost\\Ubuntu\\home\\alex\\x'], '\\\\wsl.localhost\\Ubuntu\\tmp', {
        ctrl: false,
        shift: false,
      }),
    ).toBe('move');
  });

  it('is a no-op onto the source folder, onto a dragged item, or into one', () => {
    expect(isNoOp([A], 'D:\\src')).toBe(true);
    expect(isNoOp([A], 'd:\\SRC\\')).toBe(true);
    expect(isNoOp(['D:\\src\\dir'], 'D:\\src\\dir')).toBe(true);
    expect(isNoOp(['D:\\src\\dir'], 'D:\\src\\dir\\deeper')).toBe(true);
    expect(isNoOp([A], 'D:\\src\\dir')).toBe(false);
  });

  describe('off Windows', () => {
    const DRIVES = ['/', '/media/alex/USB'];

    beforeEach(() => {
      vi.stubGlobal('window', {
        __TROVE_PLATFORM__: { os: 'linux', thisPcLabel: 'This Computer' },
      });
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it('the volume is the deepest listed drive a path sits under, else the root', () => {
      expect(volumeOf('/home/alex/a.txt', DRIVES)).toBe(volumeOf('/tmp', DRIVES));
      expect(volumeOf('/media/alex/USB/x', DRIVES)).toBe(volumeOf('/media/alex/USB', DRIVES));
      expect(volumeOf('/media/alex/USB/x', DRIVES)).not.toBe(volumeOf('/home/alex', DRIVES));
      // case matters on Linux: `/media/alex/usb` is not the USB stick
      expect(volumeOf('/media/alex/usb/x', DRIVES)).toBe(volumeOf('/home', DRIVES));
      // nothing listed yet: one volume, so a drop moves, as Finder and Files do
      expect(volumeOf('/media/alex/USB/x', [])).toBe(volumeOf('/home', []));
    });

    it('is a no-op by POSIX paths, case kept', () => {
      expect(isNoOp(['/home/alex/a.txt'], '/home/alex/')).toBe(true);
      expect(isNoOp(['/home/alex/dir'], '/home/alex/dir/deeper')).toBe(true);
      expect(isNoOp(['/home/alex/a.txt'], '/home/Alex')).toBe(false);
      expect(isNoOp(['/a.txt'], '/')).toBe(true);
    });
  });
});

describe('drag', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    selection.clear();
    drag.cancel();
    drag.resolveTarget = () => null;
    transfers.pending = null;
    vi.mocked(startTransfer).mockClear();
    vi.mocked(transferConflicts).mockClear();
    vi.mocked(dragOut).mockClear();
    vi.mocked(dropModifiers).mockReset().mockResolvedValue({ ctrl: false, shift: false });
    vi.mocked(sameVolume).mockReset().mockResolvedValue(true);
    tabs.active.location = { kind: 'path', path: 'D:\\src' };
    drag.viewport = () => ({ width: 800, height: 600 });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('start selects an unselected lead row and keeps a selection that includes it', () => {
    drag.start([A], 0, 0);
    expect(drag.dragging).toBe(true);
    expect(selection.has(A)).toBe(true);
    expect(selection.focused).toBe(A);
    drag.cancel();

    selection.selectAll([A, B]);
    drag.start([A, B], 0, 0);
    expect(selection.count).toBe(2);
    expect(drag.count).toBe(2);
  });

  it('drop onto a folder on the same volume moves; Ctrl copies', async () => {
    drag.resolveTarget = () => row('D:\\dest');
    drag.start([A], 5, 5);
    expect(drag.target?.path).toBe('D:\\dest');
    expect(drag.effect).toBe('move');
    await drag.drop();
    expect(transferConflicts).toHaveBeenCalledWith([A], 'D:\\dest');
    expect(startTransfer).toHaveBeenCalledWith([A], 'D:\\dest', 'move', 'skip');
    expect(drag.dragging).toBe(false);
    expect(drag.swallowClick()).toBe(true);
    expect(drag.swallowClick()).toBe(false);

    drag.start([A], 5, 5);
    drag.move(6, 6, { ctrl: true, shift: false });
    expect(drag.effect).toBe('copy');
    await drag.drop();
    expect(startTransfer).toHaveBeenLastCalledWith([A], 'D:\\dest', 'copy', 'skip');
  });

  it('the device id decides, not the drive list: a disk image the list leaves out copies', async () => {
    // Mac test (d): /Volumes/TroveTest is no listed drive, so the guess said "same volume"
    vi.mocked(sameVolume).mockResolvedValue(false);
    drag.resolveTarget = () => row('D:\\dest');
    drag.start([A], 5, 5);
    expect(sameVolume).toHaveBeenCalledWith([A], 'D:\\dest');
    await vi.waitFor(() => expect(drag.effect).toBe('copy'));
    await drag.drop();
    expect(startTransfer).toHaveBeenLastCalledWith([A], 'D:\\dest', 'copy', 'skip');
    // asked once for the target, however much the pointer moves over it; the drop reused it
    expect(sameVolume).toHaveBeenCalledTimes(1);
  });

  it('a "same volume" answer moves even where the guess says another drive', async () => {
    drag.resolveTarget = () => row('C:\\dest');
    drag.start([A], 5, 5);
    drag.move(6, 6, { ctrl: false, shift: false });
    drag.move(7, 7, { ctrl: false, shift: false });
    await drag.drop();
    expect(startTransfer).toHaveBeenLastCalledWith([A], 'C:\\dest', 'move', 'skip');
    expect(sameVolume).toHaveBeenCalledTimes(1);
  });

  it('a failed ask copies, the safe choice', async () => {
    vi.mocked(sameVolume).mockRejectedValue(new Error('no such path'));
    drag.resolveTarget = () => row('D:\\dest');
    drag.start([A], 5, 5);
    await drag.drop();
    expect(startTransfer).toHaveBeenLastCalledWith([A], 'D:\\dest', 'copy', 'skip');
  });

  it('Ctrl and Shift decide the drop without the answer', async () => {
    vi.mocked(sameVolume).mockResolvedValue(false);
    drag.resolveTarget = () => row('D:\\dest');
    drag.start([A], 5, 5);
    drag.move(6, 6, { ctrl: false, shift: true });
    await drag.drop();
    expect(startTransfer).toHaveBeenLastCalledWith([A], 'D:\\dest', 'move', 'skip');
    vi.mocked(sameVolume).mockResolvedValue(true);
    drag.start([A], 5, 5);
    drag.move(6, 6, { ctrl: true, shift: false });
    await drag.drop();
    expect(startTransfer).toHaveBeenLastCalledWith([A], 'D:\\dest', 'copy', 'skip');
  });

  it('a drop with the copy key held never asks', async () => {
    drag.resolveTarget = () => null;
    drag.start([A], 5, 5);
    drag.resolveTarget = () => row('D:\\dest');
    drag.move(6, 6, { ctrl: true, shift: false });
    vi.mocked(sameVolume).mockClear();
    await drag.drop();
    expect(sameVolume).not.toHaveBeenCalled();
    expect(startTransfer).toHaveBeenLastCalledWith([A], 'D:\\dest', 'copy', 'skip');
  });

  it('drop onto the source folder or a dragged item does nothing', async () => {
    drag.resolveTarget = () => ({ path: 'D:\\src', kind: 'background', tab: null });
    drag.start([A], 0, 0);
    await drag.drop();
    drag.resolveTarget = () => row('D:\\src\\dir');
    drag.start(['D:\\src\\dir'], 0, 0);
    await drag.drop();
    expect(startTransfer).not.toHaveBeenCalled();
    expect(transferConflicts).not.toHaveBeenCalled();
  });

  it('cancel resets everything and the next click is not swallowed', () => {
    drag.resolveTarget = () => row('D:\\dest');
    drag.start([A], 1, 1);
    drag.cancel();
    expect(drag.dragging).toBe(false);
    expect(drag.paths).toEqual([]);
    expect(drag.target).toBeNull();
    expect(drag.swallowClick()).toBe(true); // the pointer-up that follows a cancelled drag
    drag.cancel(); // not dragging: nothing to swallow
    expect(drag.swallowClick()).toBe(false);
  });

  it('hovering a tab for a second activates it; moving away first does not', () => {
    tabs.open('');
    tabs.activate(0);
    drag.resolveTarget = () => ({ path: 'D:\\x', kind: 'tab', tab: 1 });
    drag.start([A], 0, 0);
    drag.move(1, 1, { ctrl: false, shift: false });
    vi.advanceTimersByTime(AUTO_OPEN_MS - 1);
    expect(tabs.activeIndex).toBe(0);
    vi.advanceTimersByTime(1);
    expect(tabs.activeIndex).toBe(1);
    drag.cancel();

    tabs.activate(0);
    drag.start([A], 0, 0);
    drag.resolveTarget = () => null;
    drag.move(2, 2, { ctrl: false, shift: false });
    vi.advanceTimersByTime(AUTO_OPEN_MS);
    expect(tabs.activeIndex).toBe(0);
    drag.cancel();
    tabs.close(1);
  });

  it('a spring-opened folder keeps the drag, and a drop inside it lands there', async () => {
    // B.7.3: the drag must outlive the list swapping to the folder it sprang open
    drag.resolveTarget = () => row('D:\\dest');
    drag.start([A, B], 0, 0);
    vi.advanceTimersByTime(AUTO_OPEN_MS);
    await vi.waitFor(() => expect(tabs.active.path).toBe('D:\\dest'));
    expect(drag.dragging).toBe(true);
    expect(drag.paths).toEqual([A, B]);

    // a row of the opened folder takes the drop; the items go from their real paths
    drag.resolveTarget = () => row('D:\\dest\\inner');
    drag.move(3, 3, { ctrl: false, shift: false });
    await drag.drop();
    expect(startTransfer).toHaveBeenLastCalledWith([A, B], 'D:\\dest\\inner', 'move', 'skip');
  });

  it('an external drop across drives copies into the target, else into the current folder', async () => {
    vi.mocked(sameVolume).mockResolvedValue(false);
    drag.resolveTarget = () => row('D:\\dest');
    await drag.externalDrop(['C:\\from\\x.png'], 0, 0);
    expect(startTransfer).toHaveBeenLastCalledWith(['C:\\from\\x.png'], 'D:\\dest', 'copy', 'skip');
    drag.resolveTarget = () => null;
    await drag.externalDrop(['C:\\from\\y.png'], 0, 0);
    expect(startTransfer).toHaveBeenLastCalledWith(['C:\\from\\y.png'], 'D:\\src', 'copy', 'skip');
    drag.externalOver(0, 0);
    expect(drag.external).toBe(true);
    drag.cancel();
    expect(drag.external).toBe(false);
  });

  it("another app's drop follows Explorer: move on the same drive, copy across", async () => {
    drag.resolveTarget = () => row('D:\\dest');
    await drag.externalDrop(['D:\\from\\x.png'], 0, 0);
    expect(sameVolume).toHaveBeenLastCalledWith(['D:\\from\\x.png'], 'D:\\dest');
    expect(startTransfer).toHaveBeenLastCalledWith(['D:\\from\\x.png'], 'D:\\dest', 'move', 'skip');
    vi.mocked(sameVolume).mockResolvedValueOnce(false);
    await drag.externalDrop(['C:\\from\\y.png'], 0, 0);
    expect(startTransfer).toHaveBeenLastCalledWith(['C:\\from\\y.png'], 'D:\\dest', 'copy', 'skip');
  });

  it("another app's drop: Ctrl held at the drop copies, Shift moves, without asking the drive", async () => {
    drag.resolveTarget = () => row('D:\\dest');
    vi.mocked(dropModifiers).mockResolvedValueOnce({ ctrl: true, shift: false });
    await drag.externalDrop(['D:\\from\\x.png'], 0, 0);
    expect(startTransfer).toHaveBeenLastCalledWith(['D:\\from\\x.png'], 'D:\\dest', 'copy', 'skip');
    vi.mocked(dropModifiers).mockResolvedValueOnce({ ctrl: false, shift: true });
    await drag.externalDrop(['C:\\from\\y.png'], 0, 0);
    expect(startTransfer).toHaveBeenLastCalledWith(['C:\\from\\y.png'], 'D:\\dest', 'move', 'skip');
    expect(sameVolume).not.toHaveBeenCalled();
  });

  it("another app's drop whose key read fails follows the drive rule", async () => {
    drag.resolveTarget = () => row('D:\\dest');
    vi.mocked(dropModifiers).mockRejectedValueOnce(new Error('no keyboard'));
    vi.mocked(sameVolume).mockResolvedValueOnce(false);
    await drag.externalDrop(['C:\\from\\x.png'], 0, 0);
    expect(startTransfer).toHaveBeenLastCalledWith(['C:\\from\\x.png'], 'D:\\dest', 'copy', 'skip');
  });

  it('leaving the window hands the drag to the OS once, releasing the pointer first', async () => {
    let released = 0;
    drag.releasePointer = () => released++;
    drag.start([A, B], 10, 10);
    drag.move(-5, 10, { ctrl: false, shift: false });
    drag.move(-6, 10, { ctrl: false, shift: false });
    await vi.waitFor(() => expect(dragOut).toHaveBeenCalledTimes(1));
    expect(dragOut).toHaveBeenCalledWith([A, B], true);
    expect(released).toBe(1);
    expect(drag.dragging).toBe(false);
    drag.releasePointer = () => {};
  });

  it('handOff resets the drag before releasing the pointer, so the capture loss finds nothing', async () => {
    const seen: boolean[] = [];
    drag.releasePointer = () => {
      seen.push(drag.dragging);
      drag.cancel(); // what a lostpointercapture handler does
    };
    drag.start([A], 10, 10);
    drag.move(-5, 10, { ctrl: false, shift: false });
    await vi.waitFor(() => expect(dragOut).toHaveBeenCalledTimes(1));
    expect(seen).toEqual([false]);
    expect(dragOut).toHaveBeenCalledWith([A], true);
    drag.releasePointer = () => {};
  });

  it('off Windows, leaving the window hands the drag to the OS the same way', async () => {
    vi.stubGlobal('window', { __TROVE_PLATFORM__: { os: 'linux', thisPcLabel: 'This Computer' } });
    try {
      notices.clear();
      drag.start([A], 10, 10);
      drag.move(-5, 10, { ctrl: false, shift: false });
      expect(drag.dragging).toBe(false);
      await vi.waitFor(() => expect(dragOut).toHaveBeenCalledTimes(1));
      expect(dragOut).toHaveBeenCalledWith([A], true);
      expect(notices.list).toHaveLength(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('a move outcome re-reads the folder; Ctrl held offers copy only', async () => {
    vi.mocked(dragOut).mockResolvedValueOnce({ effect: 'move' });
    const reload = vi.spyOn(tabs.active, 'reload').mockResolvedValue();
    drag.start([A], 10, 10);
    drag.move(10, 700, { ctrl: true, shift: false });
    await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
    expect(dragOut).toHaveBeenCalledWith([A], false);
    reload.mockRestore();
  });

  it('a drop from another Trove window moves on the same volume; Ctrl held copies', async () => {
    drag.resolveTarget = () => row('D:\\dest');
    await drag.externalDrop([A], 0, 0);
    expect(startTransfer).toHaveBeenLastCalledWith([A], 'D:\\dest', 'move', 'skip');
    vi.mocked(dropModifiers).mockResolvedValueOnce({ ctrl: true, shift: false });
    await drag.externalDrop([A], 0, 0);
    expect(startTransfer).toHaveBeenLastCalledWith([A], 'D:\\dest', 'copy', 'skip');
  });

  it('a drop from another Trove window onto another device copies, by the device id', async () => {
    drag.resolveTarget = () => row('D:\\dest');
    vi.mocked(sameVolume).mockResolvedValueOnce(false);
    await drag.externalDrop([A], 0, 0);
    expect(sameVolume).toHaveBeenCalledWith([A], 'D:\\dest');
    expect(startTransfer).toHaveBeenLastCalledWith([A], 'D:\\dest', 'copy', 'skip');
  });

  it("the OS drag's leave during a handoff keeps the click that ends the press swallowed", async () => {
    let finish: (o: { effect: 'none' }) => void = () => {};
    vi.mocked(dragOut).mockImplementationOnce(() => new Promise((r) => (finish = r)));
    selection.selectAll([A, B]);
    drag.start([A, B], 10, 10);
    drag.move(-5, 10, { ctrl: true, shift: false });
    await vi.waitFor(() => expect(dragOut).toHaveBeenCalledTimes(1));
    drag.cancel(); // the drag passed over this window on its way out: Tauri's `leave`
    // a Mac's synthetic left-up clicks the row that took the press; it must not collapse 3 to 1
    expect(drag.swallowClick()).toBe(true);
    finish({ effect: 'none' });
    await vi.waitFor(() => expect(drag.handingOff).toBe(false));
    expect(selection.count).toBe(2);
  });

  it('the OS drag coming back and dropping on its own window keeps the click that ends the press swallowed', async () => {
    let finish: (o: { effect: 'none' }) => void = () => {};
    vi.mocked(dragOut).mockImplementationOnce(() => new Promise((r) => (finish = r)));
    selection.selectAll([A, B]);
    drag.start([A, B], 10, 10);
    drag.move(-5, 10, { ctrl: true, shift: false });
    await vi.waitFor(() => expect(dragOut).toHaveBeenCalledTimes(1));
    await drag.externalDrop([A, B], 0, 0); // the drag came back: Tauri's `drop` on this window
    // a Mac's synthetic left-up clicks the row that took the press; it must not collapse 2 to 1
    expect(drag.swallowClick()).toBe(true);
    finish({ effect: 'none' });
    await vi.waitFor(() => expect(drag.handingOff).toBe(false));
    expect(selection.count).toBe(2);
  });

  it('a drag handed to the OS leaves no click waiting to be swallowed once it ends', async () => {
    drag.start([A], 10, 10);
    drag.move(-5, 10, { ctrl: false, shift: false });
    await vi.waitFor(() => expect(dragOut).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(drag.handingOff).toBe(false));
    // no click follows a drag that ended in another app, so the next real click must count
    expect(drag.swallowClick()).toBe(false);
  });

  it('a drop whose transfer fails says so instead of failing silently', async () => {
    notices.list.length = 0;
    vi.mocked(transferConflicts).mockRejectedValueOnce(new Error('disk offline'));
    drag.resolveTarget = () => row('D:\\dest');
    drag.start([A], 5, 5);
    await drag.drop();
    expect(notices.list.map((n) => n.kind)).toEqual(['error']);
    expect(notices.list[0].message).toContain('disk offline');
  });

  it('an external drop whose transfer fails says so too', async () => {
    notices.list.length = 0;
    vi.mocked(transferConflicts).mockRejectedValueOnce(new Error('no access'));
    drag.resolveTarget = () => row('D:\\dest');
    await drag.externalDrop(['C:\\from\\x.png'], 0, 0);
    expect(notices.list.map((n) => n.kind)).toEqual(['error']);
  });

  describe('pin target', () => {
    const pin = (): DropTarget => ({ path: '', kind: 'pin', tab: null });
    const D = 'D:\\proj\\keep';
    const dir = { name: 'keep', path: D, isDir: true } as FileEntry;
    const file = { name: 'a.txt', path: A, isDir: false } as FileEntry;

    beforeEach(() => {
      settings.pins = [];
      vi.mocked(startTransfer).mockClear();
      vi.mocked(transferConflicts).mockClear();
    });

    it('a drop on a sidebar row still transfers', async () => {
      drag.resolveTarget = () => ({ path: 'D:\\dest', kind: 'sidebar', tab: null });
      drag.start([D], 5, 5);
      await drag.drop();
      expect(startTransfer).toHaveBeenCalledWith([D], 'D:\\dest', 'move', 'skip');
      expect(settings.pins).toEqual([]);
    });

    it('a drop on the pin tail pins the folder and transfers nothing; a second drop keeps it', async () => {
      drag.resolveTarget = pin;
      drag.start([D], 5, 5, dir);
      await drag.drop();
      await (async () => {
        drag.start([D], 5, 5, dir);
        await drag.drop();
      })();
      expect(settings.pins).toEqual([D]);
      expect(transferConflicts).not.toHaveBeenCalled();
      expect(startTransfer).not.toHaveBeenCalled();
    });

    it('a file dropped on the tail is ignored', async () => {
      drag.resolveTarget = pin;
      drag.start([A], 5, 5, file);
      await drag.drop();
      expect(settings.pins).toEqual([]);
      expect(startTransfer).not.toHaveBeenCalled();
    });

    it('a file over the pin tail has no target, so no Pin badge; a folder has one', () => {
      drag.resolveTarget = pin;
      drag.start([A], 5, 5, file);
      expect(drag.target).toBeNull();
      drag.cancel();
      drag.start([D], 5, 5, dir);
      expect(drag.target?.kind).toBe('pin');
    });

    it('a file moved off the pin tail onto a row targets the row', () => {
      drag.resolveTarget = pin;
      drag.start([A], 5, 5, file);
      drag.resolveTarget = () => row('D:\\dest');
      drag.move(6, 6, { ctrl: false, shift: false });
      expect(drag.target?.path).toBe('D:\\dest');
    });

    it('the pin tail never outlines a row, and the outline follows the pointer and clears', () => {
      drag.resolveTarget = pin;
      drag.start([D], 5, 5, dir);
      expect(drag.isTarget('/', 'row')).toBe(false); // File System folds to '' like the tail
      drag.resolveTarget = () => row('/');
      drag.move(6, 6, { ctrl: false, shift: false });
      expect(drag.isTarget('/', 'row')).toBe(true);
      drag.resolveTarget = () => row('D:\\dest');
      drag.move(7, 7, { ctrl: false, shift: false });
      expect(drag.isTarget('/', 'row')).toBe(false);
      expect(drag.isTarget('D:\\dest', 'row')).toBe(true);
      drag.resolveTarget = () => null;
      drag.move(8, 8, { ctrl: false, shift: false });
      expect(drag.isTarget('D:\\dest', 'row')).toBe(false);
    });

    it('only the surface the pointer is on lights, not every element showing that folder', () => {
      const on = (kind: DropTarget['kind']) => {
        drag.resolveTarget = () => ({ path: 'D:\\dest', kind, tab: null });
        drag.move(9, 9, { ctrl: false, shift: false });
      };
      drag.resolveTarget = () => null;
      drag.start([D], 5, 5, dir);
      const surfaces = ['row', 'sidebar', 'crumb', 'tab'] as const;
      for (const kind of surfaces) {
        on(kind);
        for (const s of surfaces) expect(drag.isTarget('D:\\dest', s)).toBe(s === kind);
      }
    });

    it('a file over its own folder lights nothing and names no action; over another folder it does', () => {
      const ghost = useDragGhost();
      drag.resolveTarget = () => row('D:\\src');
      drag.start([A], 5, 5);
      expect(drag.isTarget('D:\\src', 'row')).toBe(false);
      expect(ghost.verb).toBe('');
      drag.resolveTarget = () => row('D:\\dest');
      drag.move(6, 6, { ctrl: false, shift: false });
      expect(drag.isTarget('D:\\dest', 'row')).toBe(true);
      expect(ghost.verb).toBe('Move');
    });

    it('an external drop on the tail pins and never transfers to an empty path', async () => {
      drag.resolveTarget = pin;
      await drag.externalDrop([D, A], 0, 0);
      expect(settings.pins).toEqual([D]);
      expect(transferConflicts).not.toHaveBeenCalled();
      expect(startTransfer).not.toHaveBeenCalled();
    });
  });
});
