<!-- The hover infotip: a Fluent card at the pointer carrying the entry's icon, its name and the
     fields that matter for its kind. Explorer's is an unstyled box with no icon and no Date
     created; this is the same surface as the context-menu flyout (Menu.svelte) — layer fill,
     8 px radius, 1 px stroke, the same shadow — one step below it in z so a menu always wins.
     `pointer-events: none` is the rule that makes it safe on top of a list: it can never take
     a click, a drag or a hover away from the row under it.

     Every row but one is read straight off the entry; a folder's Size is the walk the hook
     started on the dwell, which is why the rows are derived from the tip as well as the entry
     — the card re-renders as the total climbs. -->
<script lang="ts">
  import type { FileEntry } from '$lib/types/fs';
  import { shownName } from '$lib/utils/app-bundle';
  import type { Infotip } from '$lib/hooks/use-infotip.svelte';
  import { infotipRowsFor } from '$lib/data/infotip-fields';
  import EntryIcon from '$lib/components/ui/EntryIcon.svelte';

  interface Props {
    entry: FileEntry;
    tip: Infotip;
  }
  let { entry, tip }: Props = $props();
  const rows = $derived(infotipRowsFor(entry, tip.folderSize));
</script>

{#if tip.visible}
  <div
    class="rounded-card border-divider bg-flyout z-infotip shadow-flyout pointer-events-none fixed max-w-[360px] min-w-[200px] border px-3 py-2.5 text-xs"
    style:left="{tip.position.x}px"
    style:top="{tip.position.y}px"
    role="tooltip"
    use:tip.card
  >
    <div class="flex items-start gap-2">
      <!-- the glyph, not a thumbnail: a hover card must not ask Rust to decode a picture -->
      <EntryIcon {entry} size={32} thumbs={false} />
      <span class="line-clamp-2 leading-4 font-semibold break-all">{shownName(entry)}</span>
    </div>
    <div class="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
      {#each rows as row (row.key)}
        <span class="text-text-secondary whitespace-nowrap">{row.label}</span>
        <span class="break-words">{row.value}</span>
      {/each}
    </div>
  </div>
{/if}
