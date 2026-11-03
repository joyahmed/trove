<!-- One 44 px result: icon (shell icon, glyph, or a Mac app's own icon), title, detail; the
     selected row is lit. -->
<script lang="ts">
  import Glyph from '$lib/components/ui/Glyph.svelte';
  import FolderIcon from '$lib/components/ui/FolderIcon.svelte';
  import FileTypeIcon from '$lib/components/ui/FileTypeIcon.svelte';
  import DecodedThumb from '$lib/components/ui/DecodedThumb.svelte';
  import type { KeyedIcon } from '$lib/utils/file-icon';
  import type { PaletteResult } from '$lib/types/palette';

  interface Props {
    item: PaletteResult;
    /** how the item's icon key is drawn, or null when it has none */
    icon: KeyedIcon | null;
    selected: boolean;
    /** bumped by every arrow/Tab move: when it changes, the lit row scrolls itself into view */
    keyMove: number;
    /** the pointer is over this row at screen point (x, y); the state decides if it moved */
    onhover: (x: number, y: number) => void;
    onrun: () => void;
  }
  let { item, icon, selected, keyMove, onhover, onrun }: Props = $props();

  let row = $state<HTMLDivElement | null>(null);
  let moved = -1;
  // 12 rows plus headers against a 480 px window cap means the list scrolls, and the lit row can
  // be off screen — Up from the top wraps to the last row, and the view has to follow it.
  // ⚠️ Only for a KEY move. A hover selects the row under the pointer, and scrolling that row
  // into view slides the next one under the pointer, which selects it, which scrolls again — the
  // list would walk itself under a still mouse. `keyMove` changing is the only trigger.
  $effect(() => {
    const move = keyMove;
    const bumped = moved !== move;
    moved = move;
    if (bumped && selected) row?.scrollIntoView({ block: 'nearest' });
  });
</script>

<div
  bind:this={row}
  class="rounded-control flex h-11 cursor-default items-center gap-3 px-3 {selected
    ? 'bg-subtle-selected'
    : 'hover:bg-subtle-hover'}"
  role="option"
  aria-selected={selected}
  tabindex="-1"
  onmousemove={(e) => onhover(e.screenX, e.screenY)}
  onclick={onrun}
  onkeydown={(e) => e.key === 'Enter' && onrun()}
>
  <span class="grid size-6 shrink-0 place-items-center">
    {#if icon?.kind === 'folder'}
      <FolderIcon size={18} />
    {:else if icon?.kind === 'drawn'}
      <FileTypeIcon name={icon.name} size={18} />
    {:else if icon?.kind === 'thumb'}
      <DecodedThumb path={icon.path} name={icon.name} size={18} request={48} />
    {:else if icon}
      <img src={icon.src} alt="" width="18" height="18" decoding="async" draggable="false" />
    {:else if item.glyph}
      <Glyph name={item.glyph} size={16} class="text-text-secondary" />
    {/if}
  </span>
  <span class="min-w-0 flex-1">
    <span class="block truncate text-sm">{item.title}</span>
    <span class="text-text-secondary block truncate text-xs">{item.detail}</span>
  </span>
</div>
