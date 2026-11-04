<!-- Content view: Explorer's two-line row across the whole width — a 32 px icon, the name over
     its type, then the date modified and (for a file) the size on the right. 52 px tall
     (`CONTENT_ROW_PX`), one item per chunk, like a details row. -->
<script lang="ts">
  import { rowId } from '$lib/utils/row-id';
  import type { FileEntry } from '$lib/types/fs';
  import { dropPathOf } from '$lib/utils/app-bundle';
  import { displayName } from '$lib/data/display-name';
  import { useInfotip } from '$lib/hooks/use-infotip.svelte';
  import { CONTENT_ROW_PX } from '$lib/data/view-layouts';
  import { contentFacts } from '$lib/utils/card-lines';
  import { shortKindOf } from '$lib/utils/short-kind';
  import EntryIcon from '$lib/components/ui/EntryIcon.svelte';
  import ItemCheck from './ItemCheck.svelte';
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
  const facts = $derived(contentFacts(entry));
</script>

<!-- a hairline under each row, as Explorer's Content view draws between items -->
<!-- svelte-ignore a11y_click_events_have_key_events, a11y_interactive_supports_focus -->
<div
  class="rounded-control border-divider flex w-full items-center gap-3 border-b px-2 {selected
    ? 'bg-subtle-selected'
    : 'hover:bg-subtle-hover'} {focused && !selected
    ? 'inset-ring-selection-stroke inset-ring-1'
    : ''} {entry.isHidden || cut ? 'opacity-60' : ''} {dragover
    ? 'bg-subtle-selected outline-accent outline-1'
    : ''}"
  style:height="{CONTENT_ROW_PX}px"
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
  <!-- no `title`: the infotip carries the truncated name, and a native tooltip would race it -->
  <Infotip {entry} {tip} />
  <ItemCheck {selected} />
  <EntryIcon {entry} size={32} />
  <span class="flex min-w-0 flex-1 flex-col">
    {#if renaming}
      <RenameBox />
    {:else}
      <span class="truncate text-xs leading-4">{displayName(entry)}</span>
      <span class="text-text-secondary truncate text-[11px] leading-4">{shortKindOf(entry)}</span>
    {/if}
  </span>
  <span class="flex w-56 shrink-0 flex-col">
    {#each facts as fact (fact.label)}
      <span class="truncate text-[11px] leading-4">
        <span class="text-text-secondary">{fact.label}:</span>
        {fact.value}
      </span>
    {/each}
  </span>
</div>
