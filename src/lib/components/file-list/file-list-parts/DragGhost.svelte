<!-- The picture that follows the pointer during an in-app drag: icon, name or count, verb. -->
<script lang="ts">
  import { useDragGhost } from '$lib/hooks/use-drag-ghost.svelte';
  import EntryIcon from '$lib/components/ui/EntryIcon.svelte';

  const ghost = useDragGhost();
</script>

<div
  class="bg-flyout border-divider rounded-control z-drag shadow-flyout pointer-events-none fixed flex items-center gap-2 border px-2 py-1 text-xs"
  style:left="{ghost.x + 12}px"
  style:top="{ghost.y + 12}px"
  aria-hidden="true"
>
  {#if ghost.first}
    <EntryIcon entry={ghost.first} size={16} />
  {/if}
  <span class="max-w-48 truncate">{ghost.label}</span>
  {#if ghost.verb}
    <span class="bg-accent text-accent-text rounded-control px-1.5 py-px text-[10px]"
      >{ghost.verb}</span
    >
  {/if}
</div>
