<!-- List view: small icon + name, 22 px tall, flows down then across. -->
<script lang="ts">
  import { rowId } from '$lib/utils/row-id';
  import type { FileEntry } from '$lib/types/fs';
  import { dropPathOf, shownName } from '$lib/utils/app-bundle';
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

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_interactive_supports_focus -->
<div
  class="rounded-control relative flex h-[22px] w-56 items-center gap-1.5 px-2 text-xs {selected
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
  <!-- no `title`: the infotip carries the truncated name, and a native tooltip would race it -->
  <Infotip {entry} {tip} />
  {#if selected && focused}
    <span class="bg-accent absolute top-1 bottom-1 left-0 w-[3px] rounded-full" data-mac="sel-bar"
    ></span>
  {/if}
  <EntryIcon {entry} size={16} />
  {#if renaming}
    <RenameBox wide />
  {:else}
    <span class="truncate">{shownName(entry)}</span>
  {/if}
</div>
