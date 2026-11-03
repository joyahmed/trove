<!-- An entry's icon wherever a list, a card or a pane draws one: the folder SVG, a category glyph
     or a decoded picture (off Windows), or the shell's icon (Windows) — utils/file-icon.ts — with
     the shortcut arrow over it for a link. -->
<script lang="ts">
  import type { FileEntry } from '$lib/types/fs';
  import { iconUrl } from '$lib/api/icons'; // a pure URL formatter, not an IPC call
  import { fileIconKind } from '$lib/utils/file-icon';
  import { thumbStamp } from '$lib/utils/thumb-stamp';
  import FolderIcon from './FolderIcon.svelte';
  import FileTypeIcon from './FileTypeIcon.svelte';
  import DecodedThumb from './DecodedThumb.svelte';
  import LinkBadge from './LinkBadge.svelte';

  interface Props {
    entry: Pick<FileEntry, 'isDir' | 'iconKey' | 'name' | 'path' | 'isLink'> &
      Partial<Pick<FileEntry, 'size' | 'modifiedMs'>>;
    /** the shell icon asked for, px */
    size: 16 | 32;
    /** the box it is drawn in, px; `size` by default (the preview pane draws 32 at 64) */
    box?: number;
    /** the thumbnail size asked of Rust: 48 for a 16 px icon (sharp on a 2x screen), else 96 */
    request?: 48 | 96;
    /** off Windows, a decodable picture asks for its thumbnail; false keeps its glyph */
    thumbs?: boolean;
  }
  let { entry, size, box = size, request = size === 16 ? 48 : 96, thumbs = true }: Props = $props();
  const kind = $derived.by(() => {
    const k = fileIconKind(entry);
    return k === 'thumb' && !thumbs ? 'drawn' : k;
  });
</script>

<span class="relative inline-flex shrink-0">
  {#if kind === 'folder'}
    <FolderIcon size={box} />
  {:else if kind === 'drawn'}
    <FileTypeIcon name={entry.name} size={box} />
  {:else if kind === 'thumb'}
    <DecodedThumb
      path={entry.path}
      name={entry.name}
      size={box}
      {request}
      stamp={thumbStamp(entry)}
      modifiedMs={entry.modifiedMs ?? null}
    />
  {:else}
    <img
      src={iconUrl(entry.iconKey, size)}
      alt=""
      width={box}
      height={box}
      decoding="async"
      loading="lazy"
      draggable="false"
      class="shrink-0"
    />
  {/if}
  {#if entry.isLink}<LinkBadge size={box} />{/if}
</span>
