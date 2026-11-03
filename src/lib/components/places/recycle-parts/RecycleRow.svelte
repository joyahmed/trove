<!-- One item in the Recycle Bin: the shell icon for its name, where it was, when it went.
     In the macOS Trash layout: its kind, size and when it was last modified. Cells follow the
     header's columns, so a column hidden for width is hidden here too. -->
<script lang="ts">
  import FolderIcon from '$lib/components/ui/FolderIcon.svelte';
  import FileTypeIcon from '$lib/components/ui/FileTypeIcon.svelte';
  import type { RecycleRowView } from '$lib/hooks/use-recycle-view.svelte';
  import { columnFlex, type RecycleColumn, type RecycleColumnKey } from './recycle-columns';

  interface Props {
    row: RecycleRowView;
    columns: readonly RecycleColumn[];
    onclick: (e: MouseEvent) => void;
    oncontextmenu: (e: MouseEvent) => void;
  }
  let { row, columns, onclick, oncontextmenu }: Props = $props();

  const text = (key: Exclude<RecycleColumnKey, 'name'>): string =>
    ({ origin: row.origin, kind: row.kind, size: row.size, date: row.deleted })[key];
</script>

<!-- Keyboard is handled once by the list container (use-recycle-view). -->
<!-- svelte-ignore a11y_click_events_have_key_events -->
<div
  class="h-row rounded-control mr-2 flex shrink-0 items-center {row.selected
    ? 'bg-subtle-selected'
    : 'hover:bg-subtle-hover'}"
  role="row"
  aria-selected={row.selected}
  tabindex="-1"
  title={row.item.name}
  {onclick}
  {oncontextmenu}
>
  {#each columns as col (col.key)}
    {#if col.key === 'name'}
      <span class="flex min-w-0 items-center gap-1.5 truncate px-3" style:flex={columnFlex(col)}>
        {#if row.icon.kind === 'folder'}
          <FolderIcon size={16} />
        {:else if row.icon.kind === 'drawn' || row.icon.kind === 'thumb'}
          <FileTypeIcon name={row.icon.name} size={16} />
        {:else}
          <img src={row.icon.src} alt="" width="16" height="16" decoding="async" class="shrink-0" />
        {/if}
        <span class="truncate">{row.item.name}</span>
      </span>
    {:else}
      <span
        class="text-text-secondary min-w-0 truncate px-3 {col.align === 'right'
          ? 'text-right'
          : ''}"
        style:flex={columnFlex(col)}>{text(col.key)}</span
      >
    {/if}
  {/each}
</div>
