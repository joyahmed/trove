import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useDrag } from './use-drag.svelte';
import { drag } from '$lib/state/drag.svelte';
import { selection } from '$lib/state/selection.svelte';
import { dragOut } from '$lib/api/transfer';
import type { FileEntry } from '$lib/types/fs';

vi.mock('$lib/api/transfer', () => ({
  startTransfer: vi.fn(async () => 1),
  cancelTransfer: vi.fn(async () => {}),
  transferConflicts: vi.fn(async () => []),
  onTransferProgress: vi.fn(async () => () => {}),
  onTransferDone: vi.fn(async () => () => {}),
  dragOut: vi.fn(async () => ({ effect: 'none' })),
  sameVolume: vi.fn(async () => true),
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
vi.mock('$lib/api/log', () => ({ logError: vi.fn() }));

const A = 'D:\\src\\a.txt';
const entry = { path: A, name: 'a.txt' } as FileEntry;

const rowEl = () => ({ setPointerCapture: vi.fn(), releasePointerCapture: vi.fn() });
type Row = ReturnType<typeof rowEl>;

const ev = (x: number, y: number, buttons: number, el?: Row) =>
  ({
    button: 0,
    buttons,
    clientX: x,
    clientY: y,
    pointerId: 1,
    target: el ?? null,
    currentTarget: el ?? null,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    stopPropagation: () => {},
  }) as unknown as PointerEvent;

/** A press on the row, then a 5 px move with the button down: past the 4 px threshold. */
const startDrag = (hook: ReturnType<typeof useDrag>, el: Row) => {
  hook.onRowPointerDown(entry, ev(100, 100, 1, el));
  hook.onPointerMove(ev(105, 100, 1));
};

describe('useDrag', () => {
  let hook: ReturnType<typeof useDrag>;

  beforeEach(() => {
    vi.stubGlobal('HTMLInputElement', class {});
    selection.clear();
    drag.cancel();
    vi.mocked(dragOut).mockClear();
    hook = useDrag();
    drag.resolveTarget = () => null;
    drag.viewport = () => ({ width: 800, height: 600 });
  });
  afterEach(() => {
    drag.cancel();
    vi.unstubAllGlobals();
  });

  it('a press moved past the threshold drags; a later move with the button up cancels it', () => {
    const el = rowEl();
    startDrag(hook, el);
    expect(drag.dragging).toBe(true);
    expect(el.setPointerCapture).toHaveBeenCalledWith(1);
    // the button is up but no pointerup came: never a handoff, even outside the window
    hook.onPointerMove(ev(-5, 100, 0));
    expect(drag.dragging).toBe(false);
    expect(dragOut).not.toHaveBeenCalled();
  });

  it('a pointercancel while dragging cancels the drag, and a pending press is forgotten', () => {
    startDrag(hook, rowEl());
    hook.onPointerCancel();
    expect(drag.dragging).toBe(false);

    hook.onRowPointerDown(entry, ev(100, 100, 1, rowEl()));
    hook.onPointerCancel();
    hook.onPointerMove(ev(110, 100, 1));
    expect(drag.dragging).toBe(false);
    expect(dragOut).not.toHaveBeenCalled();
  });

  it('after a handoff the capture loss is a no-op and the next press drags afresh', async () => {
    const el = rowEl();
    startDrag(hook, el);
    hook.onPointerMove(ev(-5, 100, 1));
    await vi.waitFor(() => expect(dragOut).toHaveBeenCalledTimes(1));
    expect(el.releasePointerCapture).toHaveBeenCalledWith(1);
    await vi.waitFor(() => expect(drag.handingOff).toBe(false));

    hook.onPointerCancel(); // the lostpointercapture the release caused
    expect(drag.dragging).toBe(false);
    expect(dragOut).toHaveBeenCalledTimes(1);

    const next = rowEl();
    startDrag(hook, next);
    expect(drag.dragging).toBe(true);
    expect(next.setPointerCapture).toHaveBeenCalledWith(1);
  });

  it('a spring-open that unmounts the dragged row keeps the drag; the capture moves to the body', () => {
    // B.7.3: the list swapped to the opened folder, the captured row left the DOM and its
    // capture went with it — the button is still down, so the drag goes on
    const body = { ...rowEl(), isConnected: true };
    vi.stubGlobal('document', { body });
    const el = { ...rowEl(), isConnected: true };
    startDrag(hook, el);
    el.isConnected = false;
    hook.onPointerCancel({ type: 'lostpointercapture' } as PointerEvent);
    expect(drag.dragging).toBe(true);
    expect(drag.paths).toEqual([A]);
    expect(body.setPointerCapture).toHaveBeenCalledWith(1);
    hook.onPointerMove(ev(120, 100, 1));
    expect(drag.dragging).toBe(true);
    drag.cancel();

    // the row still mounted: a lost capture is the OS taking the pointer, the drag ends
    const kept = { ...rowEl(), isConnected: true };
    startDrag(hook, kept);
    hook.onPointerCancel({ type: 'lostpointercapture' } as PointerEvent);
    expect(drag.dragging).toBe(false);
  });
});
