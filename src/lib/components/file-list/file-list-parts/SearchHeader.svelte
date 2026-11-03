<!-- Above the results: "Search results in <folder>", the count, Stop while running, × to leave. -->
<script lang="ts">
  import { useSearchHeader } from '$lib/hooks/use-search-header.svelte';
  import Glyph from '$lib/components/ui/Glyph.svelte';

  const header = useSearchHeader();
</script>

<div class="flex h-8 shrink-0 items-center gap-2 pr-3 text-sm">
  <span class="truncate">{header.title}</span>
  <span class="text-text-secondary">({header.count})</span>
  {#if header.error}
    <span class="text-critical truncate">{header.error}</span>
  {/if}
  <div class="flex-1"></div>
  {#if header.running}
    <button
      type="button"
      class="rounded-control hover:bg-subtle-hover px-2 py-0.5 text-xs"
      onclick={header.cancel}>Stop</button
    >
  {/if}
  <button
    type="button"
    class="rounded-control hover:bg-subtle-hover grid size-6 place-items-center"
    title="Close search"
    aria-label="Close search"
    onclick={header.close}
  >
    <Glyph name="close" size={9} />
  </button>
</div>
