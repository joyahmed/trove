<!-- Tiles view: Explorer's card — the 48 px icon beside the name, the type and (for a file) the
     size. Fixed 256 × 64 px (`TILES_CARD`), so the virtualizer packs them in rows. -->
<script lang="ts">
  import { rowId } from '$lib/utils/row-id';
  import type { FileEntry } from '$lib/types/fs';
  import { dropPathOf, shownName } from '$lib/utils/app-bundle';
  import { useInfotip } from '$lib/hooks/use-infotip.svelte';
  import { TILES_CARD } from '$lib/data/view-layouts';
  import { tileLines } from '$lib/utils/card-lines';
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
  const lines = $derived(tileLines(entry));
</script>

<!-- the same selection chip as FileTile: the fill says selected, a 1px inset rim the cursor -->
<!-- svelte-ignore a11y_click_events_have_key_events, a11y_interactive_supports_focus -->
<div
  class="rounded-card flex items-center gap-3 overflow-hidden px-2 {selected
    ? 'bg-selection'
    : 'hover:bg-subtle-hover'} {focused
    ? 'inset-ring-selection-stroke inset-ring-1'
    : ''} {entry.isHidden || cut ? 'opacity-60' : ''} {dragover
    ? 'bg-selection outline-accent outline-1'
    : ''}"
  style:width="{TILES_CARD.width}px"
  style:height="{TILES_CARD.height}px"
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
  <!-- no `title`: the infotip carries the clamped name, and a native tooltip would race it -->
  <Infotip {entry} {tip} />
  <EntryIcon {entry} size={32} box={TILES_CARD.icon} />
  <span class="flex min-w-0 flex-1 flex-col">
    {#if renaming}
      <RenameBox />
    {:else}
      <span class="truncate text-xs leading-4">{shownName(entry)}</span>
      {#each lines as line, i (i)}
        <span class="text-text-secondary truncate text-[11px] leading-4">{line}</span>
      {/each}
    {/if}
  </span>
</div>
