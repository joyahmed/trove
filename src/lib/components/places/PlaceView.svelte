<!-- Home and This PC: Explorer's tile view. Sections come from data/place-tiles, one header
     and one wrapped row of tiles per section. The tiles are one Tab stop; the arrow keys, Home and
     End move between them (use-place-view). Gallery, Applications and the Recycle Bin are their own views. -->
<script lang="ts">
  import { usePlaceView } from '$lib/hooks/use-place-view.svelte';
  import Glyph from '$lib/components/ui/Glyph.svelte';
  import Menu from '$lib/components/ui/Menu.svelte';
  import DriveTile from './place-view-parts/DriveTile.svelte';
  import FolderTile from './place-view-parts/FolderTile.svelte';
  import FileTileCard from './place-view-parts/FileTileCard.svelte';
  import GalleryView from './gallery-parts/GalleryView.svelte';
  import { picturesGallery } from '$lib/state/gallery.svelte';
  import ApplicationsView from './applications-parts/ApplicationsView.svelte';
  import RecycleBinView from './recycle-parts/RecycleBinView.svelte';

  const view = usePlaceView();
</script>

{#if view.kind === 'gallery'}
  <GalleryView source={picturesGallery} />
{:else if view.kind === 'applications'}
  <ApplicationsView />
{:else if view.kind === 'recycle-bin'}
  <RecycleBinView />
{:else}
  <!-- F5 from any tile (or a click on blank space) bubbles here; the group itself is no action. -->
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <div
    class="flex min-h-0 min-w-0 flex-1 flex-col overflow-auto px-5 pt-2 text-xs outline-none"
    role="group"
    aria-label={view.title}
    tabindex="-1"
    onkeydown={view.onkeydown}
    onfocusin={view.onfocusin}
  >
    {#if view.error}
      <p class="text-text-secondary p-6 text-center text-sm" role="alert">{view.error}</p>
    {/if}
    {#each view.sections as section (section.key)}
      {@const tiles = section.tiles()}
      {@const status = section.status?.()}
      <h2 class="text-text-secondary mt-2 mb-1 flex h-8 items-center gap-2 text-sm font-normal">
        <Glyph name="chevronDown" size={9} />
        <!-- No count while the OS is still answering: "(0)" next to a spinner reads as "none". -->
        <span
          >{section.title}{status?.loading && tiles.length === 0 ? '' : ` (${tiles.length})`}</span
        >
      </h2>
      <!-- ⛔ The three states stay apart here. An empty section that FAILED says so and offers a
           retry; one that is still being asked says it is still being asked (drives can take a
           minute on a dead network mapping); only a section that really holds nothing is blank. -->
      {#if status?.error}
        <p class="text-text-secondary flex items-center gap-2 pb-3" role="alert">
          <span>Couldn’t read your {section.title.toLowerCase()}.</span>
          <button
            class="hover:bg-subtle-selected rounded-xs px-2 py-1 underline"
            onclick={status.retry}>Try again</button
          >
        </p>
      {:else if status?.loading && tiles.length === 0}
        <p class="text-text-secondary pb-3">Looking for your {section.title.toLowerCase()}…</p>
      {/if}
      <div class="flex flex-wrap gap-1 pb-3">
        {#each tiles as tile (tile.key)}
          {#if tile.kind === 'drive'}
            <DriveTile
              {tile}
              tabindex={view.tabindexFor(tile.key)}
              onopen={() => view.open(tile)}
              oncontextmenu={(e) => view.oncontextmenu(tile, e)}
            />
          {:else if tile.kind === 'file'}
            <FileTileCard
              {tile}
              tabindex={view.tabindexFor(tile.key)}
              onopen={() => view.open(tile)}
            />
          {:else}
            <FolderTile
              {tile}
              tabindex={view.tabindexFor(tile.key)}
              onopen={() => view.open(tile)}
              oncontextmenu={(e) => view.oncontextmenu(tile, e)}
            />
          {/if}
        {/each}
      </div>
    {/each}
    <Menu menu={view.menu} items={view.items} />
  </div>
{/if}
