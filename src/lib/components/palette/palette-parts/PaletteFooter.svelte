<!-- Under the results: the keys that act on the lit row, and while the name index is still on a
     first walk, how far it has got (plan 21C.2a). One text-xs line: `FOOTER_HEIGHT` counts it. -->
<script lang="ts">
  import { useIndexFooter } from '$lib/hooks/use-index-footer.svelte';
  import { commandHint } from '$lib/utils/key-label';

  const footer = useIndexFooter();
  const keys = [
    { key: 'open', text: '↩ Open' },
    { key: 'reveal', text: `${commandHint('revealInFolder')} Show in folder` },
  ];
</script>

<div class="border-divider text-text-secondary flex shrink-0 gap-4 border-t px-4 py-1.5 text-xs">
  {#each keys as k (k.key)}
    <span class="shrink-0">{k.text}</span>
  {/each}
  {#if footer.indexing}
    <span class="ml-auto min-w-0 truncate" role="status">{footer.indexing}</span>
  {/if}
</div>
