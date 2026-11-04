<!-- One 44 px result: icon (shell icon, glyph, or a Mac app's own icon), title, detail, and an
     action's shortcut on the right; the selected row is lit. A quiet row (Not searched: ...) has a
     dimmed title and its action word in accent on the right. -->
<script lang="ts">
  import Glyph from '$lib/components/ui/Glyph.svelte';
  import FolderIcon from '$lib/components/ui/FolderIcon.svelte';
  import FileTypeIcon from '$lib/components/ui/FileTypeIcon.svelte';
  import DecodedThumb from '$lib/components/ui/DecodedThumb.svelte';
  import type { KeyedIcon } from '$lib/utils/file-icon';
  import type { PaletteResult } from '$lib/types/palette';
  import { tildeHome } from '$lib/utils/path-display';
  import { homeFolder } from '$lib/state/home-folder.svelte';

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
  // a path detail shows the home folder as `~` (display only; the result still runs on its path)
  const detail = $derived(tildeHome(item.detail, homeFolder.path));

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
    <span class="block truncate text-sm {item.quiet ? 'text-text-secondary' : ''}"
      >{item.title}</span
    >
    <span class="text-text-secondary block truncate text-xs" data-palette-detail="">{detail}</span>
  </span>
  <!-- the chord that does the same without the palette: File Pilot's quiet teacher (plan 08 A1) -->
  {#if item.actionLabel}<span
      class="text-accent shrink-0 text-xs font-semibold"
      data-palette-action="">{item.actionLabel}</span
    >{/if}
  {#if item.hint}<span class="text-text-secondary shrink-0 text-xs" data-palette-hint=""
      >{item.hint}</span
    >{/if}
</div>
