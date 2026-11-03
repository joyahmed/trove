<!-- Gallery: Explorer's photo view — the pictures and videos from Pictures (the Gallery place), or
     one folder's files (a folder in Gallery view, plan 15 G.52), newest first, grouped by month. Windowed: every heading and row of squares has a known height
     (`planGallery`), so only the lines near the viewport are mounted, absolutely placed inside
     a box as tall as the whole gallery. The general row virtualizer does not fit a grid of
     squares, and mounting every photo's <img> at once does not survive a big Pictures folder. -->
<script lang="ts">
  import { useGalleryView } from '$lib/hooks/use-gallery-view.svelte';
  import type { GallerySource } from '$lib/state/gallery.svelte';
  import Menu from '$lib/components/ui/Menu.svelte';
  import GalleryGroup from './GalleryGroup.svelte';
  import GalleryRow from './GalleryRow.svelte';

  interface Props {
    source: GallerySource;
  }
  let { source }: Props = $props();
  const view = useGalleryView(() => source);
</script>

<div
  class="flex min-h-0 min-w-0 flex-1 flex-col overflow-auto px-5 pt-2 text-xs outline-none"
  role="listbox"
  aria-label={view.label}
  tabindex="0"
  onkeydown={view.onkeydown}
  use:view.track
>
  {#if view.error}
    <p class="text-text-secondary p-6 text-center text-sm" role="alert">{view.error}</p>
  {:else if view.loading && view.count === 0}
    <p class="text-text-secondary p-6 text-center text-sm">{view.loadingText}</p>
  {:else if !view.loading && view.count === 0}
    <p class="text-text-secondary p-6 text-center text-sm">{view.emptyText}</p>
  {/if}
  <div class="relative shrink-0" style:height="{view.height}px">
    {#each view.visible as line (line.key)}
      <div class="absolute inset-x-0" style:top="{line.top}px">
        {#if line.kind === 'header'}
          <GalleryGroup group={line.group} />
        {:else}
          <GalleryRow items={line.items} onopen={view.open} oncontextmenu={view.oncontextmenu} />
        {/if}
      </div>
    {/each}
  </div>
  <Menu menu={view.menu} items={view.items} />
</div>
