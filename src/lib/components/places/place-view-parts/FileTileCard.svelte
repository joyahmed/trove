<!-- One of Windows' recent files on Home: shell icon, name, the folder it lives in, when. -->
<script lang="ts">
  import type { PlaceTile } from '$lib/data/place-tiles';
  import EntryIcon from '$lib/components/ui/EntryIcon.svelte';
  import { fmtDate } from '$lib/utils/format';
  import { parentOf } from '$lib/utils/path';

  interface Props {
    tile: Extract<PlaceTile, { kind: 'file' }>;
    /** 0 for the view's one Tab stop, -1 for the rest (the arrow keys reach them) */
    tabindex: number;
    onopen: () => void;
  }
  let { tile, tabindex, onopen }: Props = $props();

  const folder = $derived(parentOf(tile.entry.path) ?? '');
</script>

<div
  class="rounded-card hover:bg-subtle-hover active:bg-subtle-pressed flex w-[264px] items-center gap-3 px-2 py-2"
  role="button"
  {tabindex}
  data-place-tile={tile.key}
  title={tile.entry.path}
  ondblclick={onopen}
  onkeydown={(e) => e.key === 'Enter' && onopen()}
>
  <span class="grid h-12 w-12 shrink-0 place-items-center">
    <EntryIcon entry={tile.entry} size={32} />
  </span>
  <div class="flex min-w-0 flex-1 flex-col gap-0.5">
    <span class="truncate text-sm">{tile.entry.name}</span>
    <span class="text-text-secondary truncate">{folder}</span>
    <span class="text-text-secondary">{fmtDate(tile.entry.modifiedMs)}</span>
  </div>
</div>
