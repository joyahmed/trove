<script lang="ts">
  import { drag } from '$lib/state/drag.svelte';

  const armed = $derived((drag.dragging || drag.external) && drag.canPin);
  const over = $derived(drag.target?.kind === 'pin');
</script>

<!-- the drop zone under the sidebar's list: a folder dropped here is pinned, not moved -->
<div
  class="rounded-control mx-1 flex shrink-0 items-center justify-center text-xs {armed
    ? 'text-text-secondary min-h-navitem'
    : 'h-1'} {over ? 'bg-subtle-selected outline-accent outline-1' : ''}"
  data-drop=""
  data-drop-kind="pin"
>
  {#if armed}Drop a folder to pin{/if}
</div>
