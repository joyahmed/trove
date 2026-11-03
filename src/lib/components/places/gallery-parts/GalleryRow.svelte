<!-- One wrapped row of Gallery thumbnails. The Gallery mounts only the rows near the viewport,
     so a few thousand photos are a few dozen <img>s. In a folder's Gallery view a folder or a
     document is a plain icon-and-name tile in the same square (plan 15 G.52). -->
<script lang="ts">
  import type { FileEntry } from '$lib/types/fs';
  import { GAP_PX, THUMB_PX, isGalleryMedia } from '$lib/state/gallery.svelte';
  import GalleryThumb from './GalleryThumb.svelte';
  import GalleryItemTile from './GalleryItemTile.svelte';

  interface Props {
    items: FileEntry[];
    onopen: (entry: FileEntry) => void;
    oncontextmenu: (entry: FileEntry, e: MouseEvent) => void;
  }
  let { items, onopen, oncontextmenu }: Props = $props();
</script>

<div class="flex" style:gap="{GAP_PX}px" style:height="{THUMB_PX}px">
  {#each items as entry (entry.path)}
    {#if isGalleryMedia(entry)}
      <GalleryThumb
        {entry}
        onopen={() => onopen(entry)}
        oncontextmenu={(e) => oncontextmenu(entry, e)}
      />
    {:else}
      <GalleryItemTile
        {entry}
        onopen={() => onopen(entry)}
        oncontextmenu={(e) => oncontextmenu(entry, e)}
      />
    {/if}
  {/each}
</div>
