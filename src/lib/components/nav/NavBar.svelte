<script lang="ts">
  import { commandTrailing } from '$lib/data/command-actions';
  import { navActions } from '$lib/data/nav-actions';
  import { useCommandBar } from '$lib/hooks/use-command-bar.svelte';
  import { useToolbarFit } from '$lib/hooks/use-toolbar-fit.svelte';
  import Glyph from '$lib/components/ui/Glyph.svelte';
  import Menu from '$lib/components/ui/Menu.svelte';
  import CommandButton from '$lib/components/shell/shell-parts/CommandButton.svelte';
  import AddressBar from './nav-parts/AddressBar.svelte';
  import NewButton from './nav-parts/NewButton.svelte';
  import SearchBox from './nav-parts/SearchBox.svelte';
  import ViewSwitch from './nav-parts/ViewSwitch.svelte';

  const bar = useCommandBar();
  const fit = useToolbarFit();
</script>

<!-- The one toolbar row (plan 12 G.1): back / forward / up / refresh, + New, the path ribbon,
     search, the view switch, then Details and Settings. Every part but the ribbon is shrink-0, so
     the ribbon gives ground (its crumbs keep the current folder in view) and nothing wraps.
     Below 816px parts give way one by one (plan 15 G.73): view switch, Details / Settings, the
     New label, Refresh, search; the "…" menu at the end offers what left. -->
<nav class="h-toolbar flex shrink-0 items-center gap-2 px-3" {@attach fit.attach}>
  <div class="flex shrink-0 items-center gap-0.5">
    {#each navActions as action (action.key)}
      {#if action.key !== 'refresh' || !fit.collapsed('refresh')}
        <button
          type="button"
          class="rounded-control hover:bg-subtle-hover active:bg-subtle-pressed disabled:text-text-disabled grid size-8 place-items-center disabled:hover:bg-transparent"
          title={action.label}
          aria-label={action.label}
          disabled={!action.enabled()}
          onclick={action.run}
        >
          <Glyph name={action.glyph} size={14} class={action.busy?.() ? 'animate-spin' : ''} />
        </button>
      {/if}
    {/each}
  </div>
  <NewButton
    onactivate={bar.activate}
    isExpanded={bar.isExpanded}
    compact={fit.collapsed('newLabel')}
  />
  <AddressBar />
  {#if !fit.collapsed('search')}<SearchBox />{/if}
  {#if !fit.collapsed('view')}<ViewSwitch />{/if}
  {#if !fit.collapsed('trailing')}
    <div class="flex shrink-0 items-center">
      {#each commandTrailing as item (item.key)}
        <CommandButton
          {item}
          expanded={bar.isExpanded(item)}
          onactivate={(e) => bar.activate(item, e)}
        />
      {/each}
    </div>
  {/if}
  {#if fit.overflow}
    <CommandButton
      item={fit.moreButton}
      expanded={bar.isExpanded(fit.moreButton)}
      onactivate={(e) => bar.activate(fit.moreButton, e)}
    />
  {/if}
</nav>

<Menu menu={bar.menu} items={bar.items} />
