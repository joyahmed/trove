<!-- The Recycle Bin: Explorer's bin as a details-like list — name, original location, date
     deleted — with Empty / Restore all in a header and Restore / Delete permanently on a row.
     The macOS Trash has no original location: name, kind, size, date modified, and no Restore.
     Not virtualized: a bin with thousands of items is rare and the rows are cheap. -->
<script lang="ts">
  import { binName } from '$lib/utils/platform';
  import { useRecycleView } from '$lib/hooks/use-recycle-view.svelte';
  import EmptyState from '$lib/components/ui/EmptyState.svelte';
  import Glyph from '$lib/components/ui/Glyph.svelte';
  import Menu from '$lib/components/ui/Menu.svelte';
  import RecycleRow from './RecycleRow.svelte';
  import { columnFlex, visibleColumns } from './recycle-columns';

  const view = useRecycleView();
  /** The header row's width; its 12 px right padding is not list room. */
  let headWidth = $state(0);
  const columns = $derived(visibleColumns(view.layout, headWidth - 12));
</script>

<div
  class="flex min-h-0 min-w-0 flex-1 flex-col pl-5 text-xs outline-none"
  role="listbox"
  data-focus-home
  aria-label={binName()}
  aria-multiselectable="true"
  tabindex="0"
  onkeydown={view.onkeydown}
  onclick={view.onBackgroundClick}
>
  <div class="flex h-10 shrink-0 items-center gap-2 pr-3">
    {#each view.headerActions as action (action.key)}
      <button
        type="button"
        class="rounded-control hover:bg-subtle-hover active:bg-subtle-pressed disabled:text-text-disabled flex h-8 items-center gap-2 px-3 text-sm disabled:hover:bg-transparent {action.danger
          ? 'text-critical'
          : ''}"
        disabled={view.count === 0}
        onclick={(e) => {
          e.stopPropagation();
          void action.run();
        }}
      >
        <Glyph name={action.glyph} size={14} />
        {action.label}
      </button>
    {/each}
  </div>
  <!-- Headers never wrap: a label that does not fit ends in "…", and the columns that do not
       fit at all are hidden lowest-priority first (recycle-columns visibleColumns). -->
  <div
    class="h-colhead text-text-secondary flex shrink-0 items-center pr-3"
    bind:clientWidth={headWidth}
  >
    {#each columns as col (col.key)}
      <span
        class="min-w-0 truncate px-3 {col.align === 'right' ? 'text-right' : ''}"
        style:flex={columnFlex(col)}
        title={col.label}>{col.label}</span
      >
    {/each}
  </div>
  <!-- A flex column so the state below can take the space the rows leave and centre in it. -->
  <div class="flex flex-1 flex-col overflow-auto pt-1 pr-1 pl-1">
    {#if view.error}
      <EmptyState glyph="errorBadge" message={view.error} tone="critical" />
    {:else if view.loading && view.count === 0}
      <EmptyState glyph="search" message={`Looking in the ${binName()}…`} />
    {:else if !view.loading && view.count === 0}
      <EmptyState glyph="delete" message={`The ${binName()} is empty.`} />
    {/if}
    {#each view.rows as row (row.item.id)}
      <RecycleRow
        {row}
        {columns}
        onclick={(e) => view.onRowClick(row.item, e)}
        oncontextmenu={(e) => view.oncontextmenu(row.item, e)}
      />
    {/each}
  </div>
  <Menu menu={view.menu} items={view.items} />
</div>
