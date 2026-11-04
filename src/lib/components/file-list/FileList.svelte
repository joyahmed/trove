<script lang="ts">
  import { tabs } from '$lib/state/tabs.svelte';
  import { isHeader, listing } from '$lib/state/listing.svelte';
  import { useFileList } from '$lib/hooks/use-file-list.svelte';
  import { useColumnDrag } from '$lib/hooks/use-column-drag.svelte';
  import { scrollMemory } from '$lib/hooks/use-scroll-memory.svelte';
  import { columns } from '$lib/state/columns.svelte';
  import { selection } from '$lib/state/selection.svelte';
  import { rowId } from '$lib/utils/row-id';
  import { locationLabel } from '$lib/utils/location';
  import ColumnHeader from './file-list-parts/ColumnHeader.svelte';
  import FileRow from './file-list-parts/FileRow.svelte';
  import FileTile from './file-list-parts/FileTile.svelte';
  import FileListItem from './file-list-parts/FileListItem.svelte';
  import FileCardTile from './file-list-parts/FileCardTile.svelte';
  import FileContentRow from './file-list-parts/FileContentRow.svelte';
  import FolderHeader from './file-list-parts/FolderHeader.svelte';
  import GroupHeader from './file-list-parts/GroupHeader.svelte';
  import ListStatus from './file-list-parts/ListStatus.svelte';
  import SearchHeader from './file-list-parts/SearchHeader.svelte';
  import DragGhost from './file-list-parts/DragGhost.svelte';
  import Menu from '$lib/components/ui/Menu.svelte';

  const list = useFileList();
  const colDrag = useColumnDrag();

  // one row component per view mode; all of them take the same props. Small icons is the List
  // item flowing across instead of down (the layout differs, the item does not).
  const rows = {
    details: FileRow,
    list: FileListItem,
    small: FileListItem,
    grid: FileTile,
    tiles: FileCardTile,
    content: FileContentRow,
  };
  // Gallery never mounts this list; if a view slips through, fall back to Details
  const Row = $derived(rows[tabs.active.view === 'gallery' ? 'details' : tabs.active.view]);
</script>

<!-- a drag started on a row keeps moving anywhere in the window; a pointer the OS takes away
     (a gesture, a capture lost without our pointerup) ends it -->
<svelte:window
  onpointermove={list.drag.onPointerMove}
  onpointerup={list.drag.onPointerUp}
  onpointercancel={list.drag.onPointerCancel}
  onlostpointercapture={list.drag.onPointerCancel}
/>

<section
  class="flex min-h-0 min-w-0 flex-1 flex-col pl-5 text-xs"
  data-mac="file-list"
  style:--spacing-row={list.compactRowPx}
>
  <FolderHeader />
  {#if listing.isSearch}
    <SearchHeader />
  {/if}
  {#if tabs.active.view === 'details'}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      class="h-colhead flex shrink-0 items-stretch overflow-hidden pr-3 pl-1"
      data-mac="colhead"
      oncontextmenu={list.contextMenu.onHeader}
    >
      {#each listing.columns as col (col.key)}
        <ColumnHeader
          {col}
          width={columns.widths[col.key]}
          active={tabs.active.sortKey === col.key}
          dir={tabs.active.sortDir}
          onsort={() => colDrag.onclick(() => tabs.active.sortBy(col.key))}
          onresize={(e) => columns.startDrag(col, e)}
          onreset={(e) => columns.reset(col, e)}
          movable={col.key !== 'name' && col.key !== 'path'}
          dragging={colDrag.dragged === col.key}
          marker={colDrag.marker(col.key)}
          onmovestart={(e) => colDrag.onpointerdown(col.key, e)}
          onkeydown={(e) => colDrag.onkeydown(col.key, e)}
        />
      {/each}
    </div>
  {/if}

  <!-- The grid is the one focus owner: the rows are not focus targets, so a click on a row puts
       focus on this element, which outlives the row (a double-click on a folder unmounts it)
       and keeps the arrow keys, Enter, Delete, F2 and type-ahead alive. -->
  <!-- Virtualized: the inner box has the full scroll size, and only the chunks in view are
       rendered, each translated to its offset (use-virtual-rows). A flex column so that
       ListStatus, the last child, can take the space the rows leave and centre in it. -->
  <div
    class="flex flex-1 flex-col overflow-auto pt-2 pr-1 pl-1 outline-none"
    role="grid"
    tabindex="0"
    aria-multiselectable="true"
    aria-label={locationLabel(tabs.active.location)}
    aria-activedescendant={selection.focused === null ? undefined : rowId(selection.focused)}
    aria-rowcount={listing.items.length}
    data-drop={tabs.active.isFolder ? tabs.active.path : undefined}
    data-drop-kind="background"
    use:list.virtual.attach
    use:scrollMemory={list.virtual.layout.horizontal}
    onclick={list.onBackgroundClick}
    onpointerdown={list.band.onpointerdown}
    onpointermove={list.band.onpointermove}
    onpointerup={list.onBackgroundPointerUp}
    oncontextmenu={list.contextMenu.onBackground}
    onkeydown={list.onkeydown}
    onwheel={list.onZoomWheel}
  >
    <!-- shrink-0: the chunks are absolutely positioned, so this box's only height is the one
         the virtualizer computes — a flex parent would otherwise shrink the scroll size away. -->
    <div
      class="relative shrink-0"
      style:height={list.virtual.layout.horizontal ? '100%' : `${list.virtual.totalSize}px`}
      style:width={list.virtual.layout.horizontal ? `${list.virtual.totalSize}px` : '100%'}
    >
      {#each list.virtual.chunks as chunk (chunk.index)}
        <!-- a heading is a chunk of its own and spans the width, whatever the view packs
             into the chunks around it -->
        <div
          class="absolute top-0 left-0 {chunk.header ? 'w-full' : list.virtual.layout.chunkClass}"
          style:transform={list.virtual.layout.horizontal
            ? `translateX(${chunk.start}px)`
            : `translateY(${chunk.start}px)`}
        >
          {#each chunk.items as item, i (isHeader(item) ? item.label : item.path)}
            {#if isHeader(item)}
              <GroupHeader
                label={item.label}
                count={item.count}
                collapsed={item.collapsed}
                height={list.virtual.layout.headerSize}
                ontoggle={() => tabs.active.toggleGroup(item.label)}
              />
            {:else}
              <Row
                entry={item}
                index={chunk.first + i}
                selected={list.isSelected(item.path)}
                focused={list.isFocused(item.path)}
                renaming={list.isRenaming(item.path)}
                cut={list.isCut(item.path)}
                dragover={item.isDir && list.drag.isTarget(item.path, 'row')}
                onclick={(e) => list.onRowClick(item, e)}
                onpointerdown={(e) => list.drag.onRowPointerDown(item, e)}
                onauxclick={(e) => list.onRowAuxClick(item, e)}
                oncontextmenu={(e) => list.contextMenu.onRow(item, e)}
                onopen={() => list.open(item)}
              />
            {/if}
          {/each}
        </div>
      {/each}
      {#if list.band.rect}
        <div
          class="border-accent bg-accent/20 pointer-events-none absolute border"
          style:left="{list.band.rect.left}px"
          style:top="{list.band.rect.top}px"
          style:width="{list.band.rect.width}px"
          style:height="{list.band.rect.height}px"
        ></div>
      {/if}
    </div>
    <ListStatus />
  </div>

  <!-- one flyout for both right-click menus; the hook picks the item set -->
  <Menu menu={list.contextMenu.menu} items={list.contextMenu.items} />
  {#if list.drag.dragging}
    <DragGhost />
  {/if}
</section>
