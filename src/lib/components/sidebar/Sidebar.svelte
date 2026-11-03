<script lang="ts">
  import { QUICK_ACCESS_KEY } from '$lib/data/sidebar-sections';
  import { useSidebar } from '$lib/hooks/use-sidebar.svelte';
  import Menu from '$lib/components/ui/Menu.svelte';
  import { locationLabel } from '$lib/utils/location';
  import SidebarItem from './sidebar-parts/SidebarItem.svelte';
  import SectionHeader from './sidebar-parts/SectionHeader.svelte';
  import PinDropTail from './sidebar-parts/PinDropTail.svelte';

  const bar = useSidebar();
</script>

<aside
  class="border-divider relative flex shrink-0 flex-col overflow-x-hidden overflow-y-auto border-r py-1 pl-2.5"
  style:width="{bar.width}px"
  data-mac="sidebar"
>
  <!-- skipped (empty) sections are not in the list, so they draw no divider either -->
  {#each bar.sections as section, i (section.key)}
    {#if i > 0}
      <div class="bg-divider my-2 ml-3 h-px" data-mac="sidebar-sep"></div>
    {/if}
    {#if section.title}
      <SectionHeader
        title={section.title}
        pinGlyph={section.key === QUICK_ACCESS_KEY}
        expanded={bar.isExpanded(section.key)}
        ontoggle={() => bar.toggle(section.key)}
        openLabel={section.location ? locationLabel(section.location) : undefined}
        onopen={section.location ? () => bar.open(section) : undefined}
      />
    {/if}
    {#if !section.title || bar.isExpanded(section.key)}
      {#each section.items() as item (item.key)}
        <SidebarItem
          {item}
          active={bar.isActive(item)}
          dragover={bar.isDragover(item)}
          expanded={item.children !== undefined && bar.isExpanded(item.key)}
          onselect={() => bar.select(item)}
          ontoggle={() => bar.toggle(item.key)}
          oncontextmenu={(e) => bar.oncontextmenu(item, e)}
          onunpin={item.pinned ? () => bar.unpin(item) : undefined}
        />
        {#if item.children && bar.isExpanded(item.key)}
          {#each item.children() as child (child.key)}
            <SidebarItem
              item={child}
              active={bar.isActive(child)}
              dragover={bar.isDragover(child)}
              expanded={false}
              nested
              onselect={() => bar.select(child)}
              ontoggle={() => {}}
              oncontextmenu={(e) => bar.oncontextmenu(child, e)}
            />
          {/each}
        {/if}
      {/each}
      {#if section.key === QUICK_ACCESS_KEY}<PinDropTail />{/if}
    {/if}
  {/each}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="hover:bg-accent z-chrome absolute top-0 right-0 bottom-0 w-1 cursor-col-resize {bar.dragging
      ? 'bg-accent'
      : ''}"
    onpointerdown={bar.onHandlePointerDown}
    onpointermove={bar.onHandlePointerMove}
    onpointerup={bar.onHandlePointerUp}
  ></div>
</aside>

<Menu menu={bar.menu} items={bar.items} />
