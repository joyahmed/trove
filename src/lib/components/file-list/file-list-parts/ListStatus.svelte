<!-- Empty / error / starting / searching states of the list, in one place. -->
<script lang="ts">
  import { useListStatus } from '$lib/hooks/use-list-status.svelte';
  import EmptyState from '$lib/components/ui/EmptyState.svelte';

  const status = useListStatus();
</script>

{#if status.error}
  <EmptyState glyph="errorBadge" message={status.error} tone="critical" />
{:else if status.starting}
  <EmptyState glyph="linux" message="Starting {status.starting}…" />
{:else if status.searching}
  <EmptyState glyph="search" message={status.searching} />
{:else if status.empty}
  <EmptyState glyph="folder" message={status.emptyText} />
{/if}
