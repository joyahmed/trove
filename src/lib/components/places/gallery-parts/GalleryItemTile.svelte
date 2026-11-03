<!-- A folder or a non-photo file in a folder's Gallery view (plan 15 G.52): its icon and its name
     in the same 160 px square a photo gets, so the grid stays one grid. Opens like a thumbnail —
     a folder navigates, a file opens in its app. -->
<script lang="ts">
  import type { FileEntry } from '$lib/types/fs';
  import { shownName } from '$lib/utils/app-bundle';
  import { isFinderOpenKey } from '$lib/utils/key-label';
  import EntryIcon from '$lib/components/ui/EntryIcon.svelte';

  interface Props {
    entry: FileEntry;
    onopen: () => void;
    oncontextmenu: (e: MouseEvent) => void;
  }
  let { entry, onopen, oncontextmenu }: Props = $props();
</script>

<div
  class="rounded-card bg-subtle-selected hover:outline-accent flex size-40 shrink-0 flex-col items-center justify-center gap-2 overflow-hidden px-2 hover:outline-1"
  role="option"
  aria-selected="false"
  tabindex="0"
  title={entry.name}
  ondblclick={onopen}
  onkeydown={(e) => {
    // Return, and on a Mac Finder's ⌘O / ⌘↓ (same as a photo tile)
    if (e.key === 'Enter' || isFinderOpenKey(e)) {
      e.preventDefault();
      onopen();
    }
  }}
  {oncontextmenu}
>
  <EntryIcon {entry} size={32} box={64} thumbs={false} />
  <span class="w-full truncate text-center text-xs">{shownName(entry)}</span>
</div>
