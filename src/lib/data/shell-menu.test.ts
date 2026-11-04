import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MenuItem } from '$lib/hooks/use-menu.svelte';
import type { ShellMenuItem } from '$lib/types/shell-verbs';
import {
  SHELL_DEADLINE_MS,
  SHELL_SLOT,
  fillSlot,
  lateRow,
  loadingRow,
  shellRows,
  tidyDividers,
  withDeadline,
} from '$lib/data/shell-menu';

const node = (label: string, id: number, extra: Partial<ShellMenuItem> = {}): ShellMenuItem => ({
  id,
  label,
  verb: null,
  enabled: true,
  separator: false,
  children: [],
  iconKey: null,
  ...extra,
});
const sep = (): ShellMenuItem => node('', 0, { separator: true });
const troveItem = (label: string): MenuItem => ({ kind: 'item', key: label, label, run: () => 0 });
const labels = (items: MenuItem[]) => items.map((i) => (i.kind === 'divider' ? '---' : i.label));

const trove: MenuItem[] = [
  troveItem('Open'),
  {
    kind: 'submenu',
    key: 'open-with',
    label: 'Open with',
    items: [troveItem('Choose another app…')],
  },
  troveItem('Open in Terminal'),
  troveItem('Open with Code'),
  { kind: 'divider', key: 'd-shell' },
  loadingRow(),
];

describe('shellRows', () => {
  it('drops the verbs Trove already does and rows Trove already shows', () => {
    const tree = [
      node('Open', 1, { verb: 'open' }),
      node('Open with Code', 2, { verb: '{1c6d}' }),
      node('Edit in Notepad', 3, { iconKey: 'menu/ab' }),
      node('Open with', 0, { children: [node('Notepad', 4)] }),
      sep(),
      node('Cut', 5, { verb: 'cut' }),
      node('Copy', 6, { verb: 'copy' }),
      sep(),
      node('Copy as path', 7, { verb: 'copyaspath' }),
      node('Share', 8, { verb: 'windows.modernshare' }),
      sep(),
      node('Properties', 9, { verb: 'properties' }),
    ];
    const rows = shellRows(tree, trove, () => 0);
    expect(labels(rows)).toEqual(['Edit in Notepad', '---', 'Share']);
    const edit = rows[0];
    expect(edit.kind === 'item' && edit.iconSrc).toContain('menu/ab');
  });

  it('keeps submenus, maps ids to run, and drops a submenu its filtering emptied', async () => {
    const run = vi.fn();
    const tree = [
      node('Send to', 0, {
        children: [node('Desktop (create shortcut)', 30), node('Mail recipient', 34)],
      }),
      node('Pointless', 0, { children: [node('Delete', 18, { verb: 'delete' })] }),
      node('Scan', 40, { enabled: false }),
    ];
    const rows = shellRows(tree, trove, run);
    expect(labels(rows)).toEqual(['Send to', 'Scan']);
    const send = rows[0];
    if (send.kind !== 'submenu') throw new Error('Send to is a submenu');
    expect(labels(send.items)).toEqual(['Desktop (create shortcut)', 'Mail recipient']);
    const mail = send.items[1];
    if (mail.kind === 'item') await mail.run();
    expect(run).toHaveBeenCalledWith(34);
    const scan = rows[1];
    expect(scan.kind === 'item' && scan.enabled?.()).toBe(false);
  });

  it('gives every row a key unique across levels', () => {
    const tree = [node('A', 0, { children: [node('x', 1), node('y', 2)] }), node('B', 3)];
    const keys: string[] = [];
    const walk = (items: MenuItem[]) =>
      items.forEach((i) => {
        keys.push(i.key);
        if (i.kind === 'submenu') walk(i.items);
      });
    walk(shellRows(tree, [], () => 0));
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('fillSlot', () => {
  it('replaces the Loading row with the rows, in place', () => {
    const filled = fillSlot(trove, [troveItem('Share'), troveItem('Send to')]);
    expect(labels(filled).slice(-3)).toEqual(['---', 'Share', 'Send to']);
    expect(filled.some((i) => i.key === SHELL_SLOT)).toBe(false);
  });

  it('drops the slot and its divider when the shell had nothing new', () => {
    expect(labels(fillSlot(trove, [])).at(-1)).toBe('Open with Code');
  });

  it('shows the late note in the same slot', () => {
    expect(labels(fillSlot(trove, [lateRow()])).at(-1)).toBe('Windows items took too long');
  });

  it('leaves a menu without a slot alone', () => {
    const plain = [troveItem('Refresh')];
    expect(fillSlot(plain, [troveItem('Share')])).toBe(plain);
  });
});

describe('tidyDividers', () => {
  it('drops leading, trailing and doubled dividers', () => {
    const d = (key: string): MenuItem => ({ kind: 'divider', key });
    expect(
      labels(tidyDividers([d('a'), troveItem('x'), d('b'), d('c'), troveItem('y'), d('e')])),
    ).toEqual(['x', '---', 'y']);
  });
});

describe('withDeadline', () => {
  afterEach(() => vi.useRealTimers());

  it('passes an answer that beats the deadline', async () => {
    vi.useFakeTimers();
    const got = withDeadline(Promise.resolve(7), SHELL_DEADLINE_MS);
    await vi.advanceTimersByTimeAsync(0);
    expect(await got).toEqual({ kind: 'ok', value: 7 });
  });

  it('calls a slow answer late and never delivers it', async () => {
    vi.useFakeTimers();
    let resolve: (v: number) => void = () => undefined;
    const slow = new Promise<number>((r) => (resolve = r));
    const got = withDeadline(slow, SHELL_DEADLINE_MS);
    await vi.advanceTimersByTimeAsync(SHELL_DEADLINE_MS);
    resolve(7);
    expect(await got).toEqual({ kind: 'late' });
  });

  it('reports a refusal as an error, not as late', async () => {
    const got = await withDeadline(Promise.reject(new Error('virtual folder')), 1000);
    expect(got.kind).toBe('error');
  });
});
