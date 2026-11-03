<!-- The right-side pane (Details or Preview), lazy-mounted on open with a shape-aware skeleton
     (CONTRIBUTING § 5), with a drag handle on its left edge.
     ⭐ `max-width` is not decoration: the pane and the sidebar are both `shrink-0`, so the file
     list is the only thing that gives, and at a 720px window 248 + 320 left it 132px — a
     name-only sliver with Date, Type and Size scrolled out of reach. The pane is the accessory,
     so the pane yields first (`panes.maxWidth`, down to its 200px floor); the chosen width is
     kept in settings and comes back the moment the window is wide enough for it. -->
<script lang="ts">
  import { usePaneHost } from '$lib/hooks/use-pane-host.svelte';
  import { paneModules, previewFits } from '$lib/data/panes';
  import { settings } from '$lib/state/settings.svelte';

  const host = usePaneHost();
  let viewportWidth = $state(window.innerWidth);
  // Preview hides (stays open) when the list could not keep its 360px; Details still just yields.
  const shown = $derived(
    host.open === 'details' ||
      (host.open === 'preview' && previewFits(viewportWidth, settings.sidebarWidth)),
  );
</script>

<svelte:window bind:innerWidth={viewportWidth} />

{#if host.open && shown}
  <aside
    class="border-divider relative flex shrink-0 flex-col border-l"
    style:width="{host.width}px"
    style:max-width={host.maxWidth}
    aria-label={host.open === 'details' ? 'Details pane' : 'Preview pane'}
  >
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      class="hover:bg-accent z-chrome absolute top-0 bottom-0 -left-0.5 w-1 cursor-col-resize {host.dragging
        ? 'bg-accent'
        : ''}"
      onpointerdown={host.onHandlePointerDown}
      onpointermove={host.onHandlePointerMove}
      onpointerup={host.onHandlePointerUp}
    ></div>
    {#await paneModules[host.open]()}
      <div class="flex flex-col gap-3 p-4">
        <div class="bg-subtle-selected h-32 w-full rounded-xs"></div>
        <div class="bg-subtle-selected h-5 w-3/4 rounded-xs"></div>
        <div class="bg-subtle-selected h-4 w-full rounded-xs"></div>
        <div class="bg-subtle-selected h-4 w-5/6 rounded-xs"></div>
        <div class="bg-subtle-selected h-4 w-2/3 rounded-xs"></div>
      </div>
    {:then { default: Pane }}
      <Pane />
    {/await}
  </aside>
{/if}
