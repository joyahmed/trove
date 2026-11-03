<!--
  A group's heading, in the details view and in the grid. One chunk of its own — `planChunks`
  gives it `layout.headerSize` along the scroll axis — so it can span the full width above the
  row of tiles it opens. The chevron folds the bucket shut; the count is the bucket's whole
  size, folded or not, the way Explorer writes it.
-->
<script lang="ts">
  import Glyph from '$lib/components/ui/Glyph.svelte';

  interface Props {
    /** the bucket text: "Today", "Large", "A" */
    label: string;
    /** rows beneath it; Explorer puts the count beside the label */
    count: number;
    collapsed: boolean;
    /** px the chunk plan gave this heading — the box has to be exactly that, or the tiles
     *  below it drift out of the virtualizer's arithmetic */
    height: number;
    ontoggle: () => void;
  }
  let { label, count, collapsed, height, ontoggle }: Props = $props();
</script>

<!-- bottom-aligned: the grid's heading is taller than the text, and the air belongs above it -->
<div class="flex w-full items-end" style:height="{height}px" role="row">
  <button
    type="button"
    class="rounded-control hover:bg-subtle-hover flex h-7 min-w-0 items-center gap-1.5 px-2 text-left font-normal"
    aria-expanded={!collapsed}
    aria-label="{label} ({count})"
    onclick={ontoggle}
  >
    <span
      class="grid w-3 shrink-0 place-items-center transition-transform {collapsed
        ? ''
        : 'rotate-90'}"
    >
      <Glyph name="chevronRight" size={9} />
    </span>
    <span class="truncate text-sm font-semibold" role="gridcell">{label}</span>
    <span class="text-text-secondary shrink-0 font-normal">({count})</span>
  </button>
  <span class="border-divider mr-2 mb-3.5 ml-2 min-w-4 flex-1 border-t" aria-hidden="true"></span>
</div>
