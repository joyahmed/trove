// The Kind / Date modified / Size chips the command bar shows while a search is on, as the
// same `CommandItem` shape the bar already renders; each opens a radio menu of presets.
import type { CommandItem } from '$lib/data/command-actions';
import { datePeriods, kindOptions, sizePresets, type SearchChips } from '$lib/data/search-filters';
import type { MenuItem } from '$lib/hooks/use-menu.svelte';
import { search } from '$lib/state/search.svelte';

/** A radio menu over one axis of the chips; picking restarts the search. */
const axisMenu = <K extends keyof SearchChips>(
  axis: K,
  options: { key: NonNullable<SearchChips[K]>; label: string }[],
): MenuItem[] => [
  {
    kind: 'item',
    key: 'any',
    label: 'Any',
    checked: () => search.chips[axis] === null,
    run: () => {
      search.chips[axis] = null;
      search.restart();
    },
  },
  { kind: 'divider', key: 'd' },
  ...options.map((o): MenuItem => ({
    kind: 'item',
    key: String(o.key),
    label: o.label,
    checked: () => search.chips[axis] === o.key,
    run: () => {
      search.chips[axis] = o.key;
      search.restart();
    },
  })),
];

/** "Kind" when nothing is picked, "Kind: Folders" when it is — read live. */
export const chipLabel = <K extends keyof SearchChips>(
  axis: K,
  name: string,
  options: { key: NonNullable<SearchChips[K]>; label: string }[],
) => {
  const picked = search.chips[axis];
  const option = picked === null ? undefined : options.find((o) => o.key === picked);
  return option ? `${name}: ${option.label}` : name;
};

const kindChoices = kindOptions.filter((o) => o.key !== 'any');

export const searchChipItems: CommandItem[] = [
  { kind: 'divider', key: 'chips' },
  {
    kind: 'labelled',
    key: 'chip-kind',
    label: () => chipLabel('kind', 'Kind', kindChoices),
    glyph: 'file',
    menu: axisMenu('kind', kindChoices),
  },
  {
    kind: 'labelled',
    key: 'chip-modified',
    label: () => chipLabel('modified', 'Date modified', datePeriods),
    glyph: 'refresh',
    menu: axisMenu('modified', datePeriods),
  },
  {
    kind: 'labelled',
    key: 'chip-size',
    label: () => chipLabel('size', 'Size', sizePresets),
    glyph: 'details',
    menu: axisMenu('size', sizePresets),
  },
];
