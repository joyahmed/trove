<!-- One folder in Home or This PC: coloured glyph, name beside it. -->
<script lang="ts">
  import type { PlaceTile } from '$lib/data/place-tiles';
  import Glyph from '$lib/components/ui/Glyph.svelte';

  interface Props {
    tile: Extract<PlaceTile, { kind: 'folder' }>;
    /** 0 for the view's one Tab stop, -1 for the rest (the arrow keys reach them) */
    tabindex: number;
    onopen: () => void;
    /** the sidebar's place menu (`place-tile-menu`) */
    oncontextmenu?: (e: MouseEvent) => void;
  }
  let { tile, tabindex, onopen, oncontextmenu }: Props = $props();
</script>

<div
  class="rounded-card hover:bg-subtle-hover active:bg-subtle-pressed flex w-[200px] items-center gap-3 px-2 py-2"
  role="button"
  {tabindex}
  data-place-tile={tile.key}
  title={tile.path}
  ondblclick={onopen}
  {oncontextmenu}
  onkeydown={(e) => e.key === 'Enter' && onopen()}
>
  <Glyph name={tile.glyph} size={40} color={tile.color} class="h-12 w-12" />
  <span class="min-w-0 flex-1 truncate text-sm leading-4" title={tile.label}>{tile.label}</span>
</div>
