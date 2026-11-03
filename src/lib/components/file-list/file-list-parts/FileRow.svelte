<!-- Details view: one 28 px row, cells at the header's widths. -->
<script lang="ts">
  import { rowId } from '$lib/utils/row-id';
  import type { FileEntry } from '$lib/types/fs';
  import { dropPathOf } from '$lib/utils/app-bundle';
  import { columns } from '$lib/state/columns.svelte';
  import { listing } from '$lib/state/listing.svelte';
  import { useInfotip } from '$lib/hooks/use-infotip.svelte';
  import EntryIcon from '$lib/components/ui/EntryIcon.svelte';
  import Infotip from './Infotip.svelte';
  import RenameBox from './RenameBox.svelte';

  interface Props {
    entry: FileEntry;
    /** position in the visible list, for aria-rowindex (rows are virtualized) */
    index: number;
    selected: boolean;
    focused: boolean;
    renaming: boolean;
    /** on the cut clipboard: dimmed until pasted */
    cut: boolean;
    /** a drag hovers this folder: it is the drop target */
    dragover: boolean;
    onclick: (e: MouseEvent) => void;
    onpointerdown: (e: PointerEvent) => void;
    /** middle-click: a folder opens in a new tab */
    onauxclick: (e: MouseEvent) => void;
    oncontextmenu: (e: MouseEvent) => void;
    onopen: () => void;
  }
  let {
    entry,
    index,
    selected,
    focused,
    renaming,
    cut,
    dragover,
    onclick,
    onpointerdown,
    onauxclick,
    oncontextmenu,
    onopen,
  }: Props = $props();
  const tip = useInfotip(() => entry);
</script>

<!-- Keyboard is handled once by the grid container (use-file-list), as a roving grid should. -->
<!-- svelte-ignore a11y_click_events_have_key_events, a11y_interactive_supports_focus -->
<div
  class="h-row rounded-control relative mr-2 flex items-center {selected
    ? 'bg-subtle-selected'
    : 'hover:bg-subtle-hover'} {focused && !selected
    ? 'inset-ring-selection-stroke inset-ring-1'
    : ''} {entry.isHidden || cut ? 'opacity-60' : ''} {dragover
    ? 'bg-subtle-selected outline-accent outline-1'
    : ''}"
  id={rowId(entry.path)}
  role="row"
  aria-rowindex={index + 1}
  aria-selected={selected}
  data-cursor={focused}
  data-drop={dropPathOf(entry)}
  data-drop-kind="row"
  {onclick}
  {onpointerdown}
  {onauxclick}
  {oncontextmenu}
  ondblclick={onopen}
  onpointerenter={tip.onpointerenter}
  onpointermove={tip.onpointermove}
  onpointerleave={tip.onpointerleave}
>
  <Infotip {entry} {tip} />
  {#if selected && focused}
    <span
      class="bg-accent absolute top-1.5 bottom-1.5 left-0 w-[3px] rounded-full"
      data-mac="sel-bar"
    ></span>
  {/if}
  {#each listing.columns as col (col.key)}
    <span
      class="flex shrink-0 items-center gap-1.5 truncate px-3 {col.align === 'right'
        ? 'justify-end'
        : ''}"
      style:width="{columns.widths[col.key]}px"
      role="gridcell"
    >
      {#if col.key === 'name'}
        <EntryIcon {entry} size={16} />
      {/if}
      {#if renaming && col.key === 'name'}
        <RenameBox />
      {:else}
        <span class="truncate">{col.cell(entry)}</span>
      {/if}
    </span>
  {/each}
</div>
