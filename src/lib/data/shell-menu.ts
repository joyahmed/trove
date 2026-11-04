// Windows' own right-click items inside Trove's one menu (plan 05 5.1b, plan 08 D.1): the shell
// tree mapped to menu rows, minus what Trove already offers, and the slot they arrive into — a
// "Loading…" row while the worker asks, the rows when they come, a quiet note when too late.
// Pure: the fetch and the timer live in `use-context-menu`.
import { iconUrl } from '$lib/api/icons'; // a pure URL formatter, not an IPC call
import type { MenuItem } from '$lib/hooks/use-menu.svelte';
import type { ShellMenuItem } from '$lib/types/shell-verbs';

/** How long Windows' items may take before the menu stops waiting for them. */
export const SHELL_DEADLINE_MS = 400;

/** The key of the one row the shell items replace. */
export const SHELL_SLOT = 'shell-slot';

/**
 * Canonical verbs whose action Trove's own rows already do. The shell's copy of them is hidden:
 * two "Delete" rows that act differently (one Trove's undoable delete, one Explorer's) is how
 * the wrong one gets clicked.
 */
export const TROVE_VERBS: ReadonlySet<string> = new Set([
  'open',
  'cut',
  'copy',
  'paste',
  'delete',
  'rename',
  'properties',
  'copyaspath',
]);

/** The row that holds the shell's place while it is asked. */
export const loadingRow = (): MenuItem => ({
  kind: 'item',
  key: SHELL_SLOT,
  label: 'Loading Windows items…',
  enabled: () => false,
  run: () => undefined,
});

/** What the slot says when the shell missed its deadline or failed: one greyed line. */
export const lateRow = (): MenuItem => ({
  kind: 'item',
  key: SHELL_SLOT,
  label: 'Windows items took too long',
  enabled: () => false,
  run: () => undefined,
});

const norm = (label: string) => label.trim().toLowerCase();

/** Every row label in `items`, flyouts included — what Trove already shows. */
const labelsOf = (items: MenuItem[]): Set<string> => {
  const out = new Set<string>();
  for (const i of items) {
    if (i.kind === 'divider') continue;
    out.add(norm(i.label));
    if (i.kind === 'submenu') labelsOf(i.items).forEach((l) => out.add(l));
  }
  return out;
};

/** No divider first, last or twice in a row. */
export const tidyDividers = (items: MenuItem[]): MenuItem[] => {
  const out: MenuItem[] = [];
  for (const i of items) {
    if (i.kind === 'divider' && (out.length === 0 || out[out.length - 1].kind === 'divider'))
      continue;
    out.push(i);
  }
  while (out.length && out[out.length - 1].kind === 'divider') out.pop();
  return out;
};

/**
 * The shell tree as menu rows. A row is dropped when its verb is one Trove does
 * (`TROVE_VERBS`) or when Trove already shows a row with the same label ("Open with",
 * "Open in Terminal"); a submenu emptied by that goes too.
 */
export const shellRows = (
  tree: ShellMenuItem[],
  trove: MenuItem[],
  run: (id: number) => unknown,
): MenuItem[] => {
  const taken = labelsOf(trove);
  const map = (nodes: ShellMenuItem[], path: string): MenuItem[] =>
    tidyDividers(
      nodes.flatMap((n, i): MenuItem[] => {
        const key = `shell:${path}${i}`;
        if (n.separator) return [{ kind: 'divider', key }];
        if (n.verb && TROVE_VERBS.has(n.verb)) return [];
        if (path === '' && taken.has(norm(n.label))) return [];
        if (n.children.length) {
          const items = map(n.children, `${path}${i}.`);
          if (items.length === 0) return [];
          return [{ kind: 'submenu', key, label: n.label, enabled: () => n.enabled, items }];
        }
        return [
          {
            kind: 'item',
            key,
            label: n.label,
            iconSrc: n.iconKey ? iconUrl(n.iconKey, 16) : undefined,
            enabled: () => n.enabled,
            run: () => run(n.id),
          },
        ];
      }),
    );
  return map(tree, '');
};

/**
 * `menu` with the slot replaced by `rows` (the slot's divider goes when `rows` is empty). A menu
 * without a slot — closed, reopened elsewhere — comes back unchanged.
 */
export const fillSlot = (menu: MenuItem[], rows: MenuItem[]): MenuItem[] => {
  const at = menu.findIndex((i) => i.key === SHELL_SLOT);
  if (at < 0) return menu;
  return tidyDividers([...menu.slice(0, at), ...rows, ...menu.slice(at + 1)]);
};

export type Arrival<T> =
  { kind: 'ok'; value: T } | { kind: 'late' } | { kind: 'error'; error: unknown };

/** `promise`, or `late` once `ms` pass first. The late value is dropped, never shown. */
export const withDeadline = <T>(promise: Promise<T>, ms: number): Promise<Arrival<T>> =>
  new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ kind: 'late' }), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve({ kind: 'ok', value });
      },
      (error: unknown) => {
        clearTimeout(timer);
        resolve({ kind: 'error', error });
      },
    );
  });
