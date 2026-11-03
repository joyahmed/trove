<!-- What the pane says when there is nothing to render: the folder, a multi-selection, or a file
     of a kind it cannot show. -->
<script lang="ts">
  import { shortKindOf } from '$lib/utils/short-kind';
  import type { FileEntry } from '$lib/types/fs';
  import EntryIcon from '$lib/components/ui/EntryIcon.svelte';
  import Glyph from '$lib/components/ui/Glyph.svelte';
  import type { PreviewIcon } from '$lib/hooks/use-preview-pane-icon';
  import FolderIcon from '$lib/components/ui/FolderIcon.svelte';

  interface Props {
    entry: FileEntry | null;
    count: number;
    folderLabel: string;
    /** null for a place, which has no file list to count */
    folderCount: number | null;
    /** what the place draws when nothing is selected; the Trash gets the bin, not a folder */
    icon?: PreviewIcon;
  }
  let { entry, count, folderLabel, folderCount, icon = 'folder' }: Props = $props();
</script>

<div class="text-text-secondary flex flex-1 flex-col items-center justify-center gap-2 text-sm">
  {#if entry}
    <EntryIcon {entry} size={32} box={64} />
    <span class="text-text max-w-full truncate">{entry.name}</span>
    <span>{shortKindOf(entry)}</span>
    {#if !entry.isDir}<span>No preview available</span>{/if}
  {:else if count > 1}
    <span>{count} items selected</span>
  {:else}
    {#if icon === 'bin'}
      <Glyph name="delete" size={64} />
    {:else}
      <FolderIcon size={64} />
    {/if}
    <span class="text-text max-w-full truncate">{folderLabel}</span>
    {#if folderCount !== null}
      <span>{folderCount} {folderCount === 1 ? 'item' : 'items'}</span>
    {/if}
  {/if}
</div>
