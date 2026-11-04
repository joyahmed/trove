<script lang="ts">
  import { actionHint } from '$lib/data/action-chords';
  import { useTabStrip } from '$lib/hooks/use-tab-strip.svelte';
  import Glyph from '$lib/components/ui/Glyph.svelte';
  import FolderIcon from '$lib/components/ui/FolderIcon.svelte';
  import { useDropTarget } from '$lib/hooks/use-drop-target.svelte';
  import { useTrafficLightInset } from '$lib/hooks/use-traffic-light-inset.svelte';

  const strip = useTabStrip();
  const drop = useDropTarget();
  // On a Mac the native traffic lights sit over the strip's left end (`tauri.macos.conf.json`).
  const lights = useTrafficLightInset();
</script>

<div class="flex h-8 min-w-0 items-stretch {lights.show ? '' : 'pl-2.5'}" role="tablist">
  {#if lights.show}
    <!-- the room the traffic lights take; still drags the window, like the bar around them -->
    <div
      class="shrink-0"
      style:width="{lights.px}px"
      aria-hidden="true"
      data-tauri-drag-region
    ></div>
  {/if}
  {#each strip.views as tab (tab.index)}
    <div
      class="flex w-60 min-w-24 items-center gap-2 pr-1 pl-3 text-xs {tab.active
        ? 'rounded-t-menu bg-tab-active'
        : 'text-text-secondary hover:bg-subtle-hover rounded-control my-0.5'} {drop.isTargetTab(
        tab.index,
      )
        ? 'outline-accent outline-1'
        : ''} {strip.slot === tab.index
        ? `border-accent ${strip.slotSide === 'after' ? 'border-r-2' : 'border-l-2'}`
        : ''}"
      role="presentation"
      data-tab={tab.index}
      data-drop={tab.path || undefined}
      data-drop-kind="tab"
      data-drop-tab={tab.index}
      onclick={() => strip.activate(tab.index)}
      onauxclick={(e) => strip.onauxclick(tab.index, e)}
      onpointerdown={(e) => strip.onpointerdown(tab.index, e)}
      onpointermove={(e) => strip.onpointermove(tab.index, e)}
      onpointerup={strip.onpointerup}
    >
      <!-- The tab is only icon + title, so its accessible name is the title. The close button is a
           sibling, not a child: a tab's children are presentational and would fold it into the name. -->
      <div
        class="flex min-w-0 flex-1 items-center gap-2 self-stretch"
        role="tab"
        aria-selected={tab.active}
        tabindex="-1"
      >
        {#if tab.icon}
          <Glyph name={tab.icon.glyph} size={16} color={tab.icon.color} />
        {:else}
          <FolderIcon size={16} />
        {/if}
        <span class="flex-1 truncate">{tab.title}</span>
      </div>
      <button
        type="button"
        class="rounded-control hover:bg-subtle-hover grid size-6 place-items-center"
        title="Close tab"
        aria-label={tab.closeLabel}
        tabindex={tab.active ? 0 : -1}
        onclick={(e) => strip.close(tab.index, e)}
      >
        <Glyph name="close" size={9} />
      </button>
    </div>
  {/each}
  <button
    type="button"
    class="rounded-control hover:bg-subtle-hover mx-1.5 grid size-8 shrink-0 place-items-center self-center"
    title={`New tab (${actionHint('new-tab') ?? ''})`}
    aria-label="New tab"
    onclick={strip.open}
  >
    <Glyph name="add" size={11} />
  </button>
</div>

<!-- The dragged tab follows the pointer; the accent border says "release here to make a window". -->
{#if strip.ghost}
  <div
    class="bg-tab-active border-divider rounded-control z-drag shadow-flyout pointer-events-none fixed flex h-8 w-60 items-center gap-2 border pl-3 text-xs {strip.detaching
      ? 'border-accent border-2'
      : ''}"
    style:left="{strip.ghost.x - 100}px"
    style:top="{strip.ghost.y - 16}px"
  >
    {#if strip.ghost.icon}
      <Glyph name={strip.ghost.icon.glyph} size={16} color={strip.ghost.icon.color} />
    {:else}
      <FolderIcon size={16} />
    {/if}
    <span class="flex-1 truncate">{strip.ghost.title}</span>
    {#if strip.detaching}<span class="text-text-secondary pr-2">New window</span>{/if}
  </div>
{/if}
