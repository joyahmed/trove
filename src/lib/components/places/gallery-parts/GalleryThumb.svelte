<!-- One photo or video in the Gallery: a 160 px square thumbnail from the shell; the name on
     hover; double-click or Enter (⌘O, ⌘↓ on a Mac) opens, right-click offers Open / Open file location. -->
<script lang="ts">
  import type { FileEntry } from '$lib/types/fs';
  // a pure URL formatter, not an IPC call
  import { thumbUrl } from '$lib/api/icons';
  import { useSettled } from '$lib/hooks/use-settled.svelte';
  import { DRAWN_FILE_ICONS, isDecodedThumbnail } from '$lib/utils/file-icon';
  import DecodedThumb from '$lib/components/ui/DecodedThumb.svelte';
  import { thumbStamp } from '$lib/utils/thumb-stamp';
  import { isFinderOpenKey } from '$lib/utils/key-label';
  import FileTypeIcon from '$lib/components/ui/FileTypeIcon.svelte';
  import { tileLabel } from '$lib/state/gallery.svelte';

  interface Props {
    entry: FileEntry;
    onopen: () => void;
    oncontextmenu: (e: MouseEvent) => void;
  }
  let { entry, onopen, oncontextmenu }: Props = $props();
  // the stamp makes a file that grew or changed a new URL: neither the HTTP cache nor the failure
  // memory below reuses a failed answer for it (B.5.5)
  const src = $derived(thumbUrl(entry.path, 256, thumbStamp(entry)));
  // a row scrolled past before it settles never asks the shell for its thumbnails
  const settled = useSettled();
  // A 503 means the icon queue dropped this request under a burst: draw nothing (the tile's
  // own fill shows) rather than a broken-image glyph. Keyed by URL so a recycled tile resets.
  let failedFor = $state('');
  // Off Windows (plan 14.2) Rust decodes the plain picture formats; a video, a HEIC or a TIFF has
  // no thumbnail at all, so it draws its category glyph and says "no preview" under it.
  const decoded = $derived(isDecodedThumbnail(entry.name));
  const label = $derived(tileLabel(entry.name, DRAWN_FILE_ICONS));
</script>

<div
  class="rounded-card bg-subtle-selected hover:outline-accent relative size-40 shrink-0 overflow-hidden hover:outline-1"
  role="option"
  aria-selected="false"
  tabindex="0"
  title={entry.name}
  ondblclick={onopen}
  onkeydown={(e) => {
    // Return, and on a Mac Finder's ⌘O / ⌘↓ (same as the file list)
    if (e.key === 'Enter' || isFinderOpenKey(e)) {
      e.preventDefault();
      onopen();
    }
  }}
  {oncontextmenu}
>
  {#if !DRAWN_FILE_ICONS}
    <img
      src={settled.ready && failedFor !== src ? src : undefined}
      onerror={() => (failedFor = src)}
      alt={entry.name}
      width={160}
      height={160}
      loading="lazy"
      decoding="async"
      draggable="false"
      class="size-full object-cover"
    />
  {:else}
    <!-- under the picture: seen only while a tile has none (a kind with no preview here, or a
         picture that failed), so a glyph never passes for a thumbnail still on its way -->
    <span
      class="text-text-secondary pointer-events-none absolute inset-x-0 bottom-3 truncate px-2 text-center text-xs"
      >{label}</span
    >
    {#if decoded}
      <DecodedThumb
        path={entry.path}
        name={entry.name}
        size={160}
        request={256}
        glyphSize={64}
        cover
        stamp={thumbStamp(entry)}
        modifiedMs={entry.modifiedMs}
      />
    {:else}
      <span class="grid size-full place-items-center"
        ><FileTypeIcon name={entry.name} size={64} /></span
      >
    {/if}
  {/if}
</div>
