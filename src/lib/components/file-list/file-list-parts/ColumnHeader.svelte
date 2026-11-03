<script lang="ts">
  import type { FileColumn } from '$lib/data/file-columns';
  import type { DropMarker } from '$lib/hooks/use-column-drag.svelte';
  import Glyph from '$lib/components/ui/Glyph.svelte';

  interface Props {
    col: FileColumn;
    width: number;
    active: boolean;
    dir: 'asc' | 'desc';
    onsort: () => void;
    onresize: (e: PointerEvent) => void;
    onreset: (e: MouseEvent) => void;
    /** can be dragged sideways / moved with Alt+←→ (not Name, not search's Folder) */
    movable: boolean;
    /** this header is the one being dragged */
    dragging: boolean;
    /** where the drop line is drawn on this header, if anywhere */
    marker: DropMarker;
    onmovestart: (e: PointerEvent) => void;
    onkeydown: (e: KeyboardEvent) => void;
  }
  let {
    col,
    width,
    active,
    dir,
    onsort,
    onresize,
    onreset,
    movable,
    dragging,
    marker,
    onmovestart,
    onkeydown,
  }: Props = $props();
</script>

<div class="relative flex shrink-0" style:width="{width}px" data-col-key={col.key}>
  <button
    type="button"
    aria-keyshortcuts={movable ? 'Alt+ArrowLeft Alt+ArrowRight' : undefined}
    class:opacity-50={dragging}
    class="text-text-secondary hover:bg-subtle-hover relative flex w-full items-center px-3 text-left text-[11px] font-medium tracking-wider uppercase {col.align ===
    'right'
      ? 'justify-end'
      : ''}"
    onclick={onsort}
    onpointerdown={onmovestart}
    {onkeydown}
  >
    {#if active}
      <Glyph
        name={dir === 'asc' ? 'chevronUpSmall' : 'chevronDownSmall'}
        size={7}
        class="mac-sort-chevron absolute top-0 left-1/2 -translate-x-1/2"
      />
    {/if}
    <span class="truncate">{col.label}</span>
  </button>
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="hover:bg-stroke-strong absolute top-1 right-0 bottom-1 w-2 cursor-col-resize bg-transparent bg-clip-content pl-[7px] hover:pl-[6px]"
    onpointerdown={onresize}
    ondblclick={onreset}
  ></div>
  <!-- the drop line while a header is dragged: last, so it paints over the button -->
  {#if marker !== null}
    <div
      class="bg-accent pointer-events-none absolute top-1 bottom-1 w-0.5 {marker === 'before'
        ? 'left-0'
        : 'right-0'}"
      aria-hidden="true"
    ></div>
  {/if}
</div>
