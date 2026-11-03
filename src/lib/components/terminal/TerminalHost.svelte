<!-- The bottom terminal pane's frame: a resize handle and the lazily mounted pane (the terminal
     emulator and its WASM never load until the pane is opened — CONTRIBUTING § 5). -->
<script lang="ts">
  import { useTerminalHost } from '$lib/hooks/use-terminal-host.svelte';

  const host = useTerminalHost();
</script>

{#if host.open}
  <section
    class="border-divider relative flex shrink-0 flex-col border-t"
    style:height="{host.height}px"
    aria-label="Terminal pane"
  >
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      class="hover:bg-accent z-chrome absolute -top-0.5 right-0 left-0 h-1 cursor-row-resize {host.dragging
        ? 'bg-accent'
        : ''}"
      onpointerdown={host.onHandlePointerDown}
      onpointermove={host.onHandlePointerMove}
      onpointerup={host.onHandlePointerUp}
    ></div>
    {#await import('./TerminalPane.svelte')}
      <div class="flex h-8 shrink-0 items-center gap-3 px-3 text-xs">
        <div class="bg-subtle-selected h-4 w-40 rounded-xs"></div>
      </div>
      <div class="bg-layer flex-1 p-2 font-mono text-xs">
        <span class="bg-text-secondary inline-block h-4 w-2 animate-pulse"></span>
      </div>
    {:then { default: Pane }}
      <Pane />
    {/await}
  </section>
{/if}
