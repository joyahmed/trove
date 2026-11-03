<!-- Fluent flyout: 8px radius, layer surface, 1px stroke, items 36px, wide enough that a label
     and its shortcut share one line (Explorer's is ~300 px). Rendered only while open,
     positioned fixed at the hook's point. A `submenu` row opens a second panel beside it. -->
<script lang="ts">
  import { type Menu, type MenuItem, capPanel, visibleItems } from '$lib/hooks/use-menu.svelte';
  import Glyph from '$lib/components/ui/Glyph.svelte';
  import { placeFlyout } from '$lib/utils/flyout-position';
  import type { Action } from 'svelte/action';

  interface Props {
    menu: Menu;
    items: MenuItem[];
  }
  let { menu, items }: Props = $props();

  // Which flyout is open at each depth is the hook's (`menu.openPath`): the keyboard opens and
  // closes flyouts too, and it lives there.
  const openSub = (key: string, depth: number) => menu.openSub(key, depth);
  const closeBelow = (depth: number) => menu.closeBelow(depth);
  /** The depth of the flyout (moved to <body>) the pointer is in, or null when in none. */
  const flyoutDepthAt = (t: EventTarget | null) => {
    const fly = t instanceof Element ? t.closest<HTMLElement>('[data-menu-flyout]') : null;
    return fly ? Number(fly.dataset.menuFlyout) : null;
  };
  /** Pointer left a row's wrapper: close its flyout unless the pointer went into it (or deeper). */
  const leaveRow = (e: MouseEvent, depth: number) => {
    const into = flyoutDepthAt(e.relatedTarget);
    if (into === null || into < depth) closeBelow(depth);
  };

  /**
   * Places a flyout once it is rendered and can be measured: beside its row (the wrapper it sits
   * in), slid up to fit the window, capped and scrollable when taller than it, flipped left when
   * there is no room on the right. It is `fixed`, in viewport px, and moved to <body> (below), and
   * it stays invisible until placed so it never flashes at a wrong spot.
   */
  const placeSub: Action<HTMLElement, { depth: number }> = (el, params) => {
    const owner = el.parentElement;
    if (!owner) return;
    const depth = params?.depth ?? 0;
    // WebKit clips a `fixed` child to a scrolling ancestor (a capped, scrolling menu would hide
    // its own flyouts), so the flyout moves to <body>. The pointer then leaves `owner` on its way
    // in, which is why the hover rules below look at where it went (`flyoutDepthAt`), not at the DOM.
    el.dataset.menuFlyout = String(depth);
    // the depth of the rows inside it, which the hook's keys read (`data-menu-level`)
    el.dataset.menuLevel = String(depth + 1);
    document.body.appendChild(el);
    const onLeaveFlyout = (e: MouseEvent) => {
      const to = e.relatedTarget;
      if (to instanceof Node && owner.contains(to)) return; // back onto the owning row
      const deeper = flyoutDepthAt(to);
      if (deeper !== null && deeper > depth) return; // into a flyout opened from this one
      closeBelow(depth);
    };
    el.addEventListener('mouseleave', onLeaveFlyout);
    const height = el.offsetHeight;
    const place = (width: number) =>
      placeFlyout({
        anchor: owner.getBoundingClientRect(),
        width,
        height,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        alignY: -6, // the panel's own py-1.5, so its first row is level with the owning row
      });
    let p = place(el.offsetWidth);
    el.style.top = `${p.top}px`;
    if (p.maxHeight !== undefined) {
      capPanel(el, p.maxHeight);
      // the scrollbar widened it: place it again so it does not run past the window's edge
      p = { ...p, left: place(el.offsetWidth).left };
    }
    el.style.left = `${p.left}px`;
    el.style.visibility = 'visible';
    return {
      destroy() {
        el.removeEventListener('mouseleave', onLeaveFlyout);
        el.remove();
      },
    };
  };

  /**
   * An icon the shell could not serve leaves the reserved slot blank rather than a broken-image
   * mark: `visibility`, not `display`, so the column keeps its width and the label stays put.
   */
  const hideBrokenIcon = (e: Event) => {
    if (e.currentTarget instanceof HTMLImageElement) e.currentTarget.style.visibility = 'hidden';
  };

  const panelClass =
    'rounded-menu border-divider bg-flyout shadow-flyout grid max-w-[440px] min-w-[300px] grid-cols-[auto_auto_1fr_auto] border py-1.5 text-[15px]';
  const rowClass =
    'focus:bg-subtle-hover disabled:text-text-disabled rounded-control col-span-4 mx-1 grid h-9 grid-cols-subgrid items-center px-3 text-left whitespace-nowrap outline-none';
</script>

<!-- One snippet for every depth: the rows of a panel, recursing into each flyout. `depth` is
     the level being drawn, and it is what makes `menu.openPath` mean one open flyout per level.
     Keyboard: every row is `tabindex="-1"` and carries `data-menu-row` (its key); the hook moves
     focus between them (roving tabindex). ONE highlight: rows light on `:focus` only, never
     `:hover`, and moving the pointer over a row focuses it (`menu.pointRow`), so the mouse and
     the keys share one lit row and the last one used decides which. -->
{#snippet rows(list: MenuItem[], depth: number)}
  {#each visibleItems(list) as item (item.key)}
    {#if item.kind === 'divider'}
      <div class="bg-divider col-span-4 mx-2 my-1.5 h-px" role="separator"></div>
    {:else if item.kind === 'submenu'}
      <!-- The flyout is rendered inside this wrapper but moved to <body> once placed (placeSub),
           so the hover rules follow where the pointer went, not the DOM. The
           wrapper cannot be `subgrid` (its child panel has to be positioned against it), so the
           button repeats the same four tracks; columns 1 and 2 are fixed widths, so the label
           still starts at the same x as every sibling row's. -->
      <!-- `presentation`: the wrapper exists to own the hover area and the flyout's positioning,
           so it stays out of the accessibility tree and the button below is the menu's child. -->
      <div
        class="relative col-span-4"
        role="presentation"
        onmouseenter={() =>
          item.enabled?.() === false ? closeBelow(depth) : openSub(item.key, depth)}
        onmouseleave={(e) => leaveRow(e, depth)}
      >
        <button
          type="button"
          class="focus:bg-subtle-hover disabled:text-text-disabled rounded-control mx-1 grid h-9 w-[calc(100%-0.5rem)] grid-cols-[auto_auto_1fr_auto] items-center px-3 text-left whitespace-nowrap outline-none"
          class:bg-subtle-hover={menu.openPath[depth] === item.key}
          role="menuitem"
          tabindex="-1"
          data-menu-row={item.key}
          data-menu-sub=""
          aria-haspopup="menu"
          aria-expanded={menu.openPath[depth] === item.key}
          disabled={item.enabled?.() === false}
          onpointermove={menu.pointRow}
          onclick={() => menu.clickSub(item.key, depth)}
        >
          <span class="grid w-4 place-items-center" data-menu-check=""></span>
          <span class="ml-3 grid size-4 shrink-0 place-items-center" data-menu-icon="">
            {#if item.glyph}<Glyph name={item.glyph} size={16} />{/if}
          </span>
          <span class="ml-3 min-w-0 truncate" data-menu-label="">{item.label}</span>
          <span class="text-text-secondary pl-6" data-menu-chevron=""
            ><Glyph name="chevronRight" size={12} /></span
          >
        </button>
        <!-- `fixed`, placed by `placeSub` once measured, and moved to <body> there (see it). -->
        {#if menu.openPath[depth] === item.key}
          <div
            class="{panelClass} z-menu invisible fixed top-0 left-0 outline-none"
            role="menu"
            tabindex="-1"
            data-menu-panel=""
            aria-label={item.label}
            use:placeSub={{ depth }}
          >
            {@render rows(item.items, depth + 1)}
          </div>
        {/if}
      </div>
    {:else}
      <button
        type="button"
        class={rowClass}
        role={item.checked ? 'menuitemcheckbox' : 'menuitem'}
        aria-checked={item.checked ? item.checked() : undefined}
        tabindex="-1"
        data-menu-row={item.key}
        disabled={item.enabled?.() === false}
        onmouseenter={() => closeBelow(depth)}
        onpointermove={menu.pointRow}
        onclick={() => menu.run(item)}
      >
        <span class="grid w-4 place-items-center" data-menu-check="">
          {#if item.checked?.()}<Glyph name="check" size={12} />{/if}
        </span>
        <!-- The leading icon column is ALWAYS reserved, even when the item has no icon: a
             registry verb and a built-in item then start their label at the same x. Losing the
             slot is what made one menu look like two — the iconless rows jumped 28px left and
             read as a second, larger type scale. A blank beats a ragged edge. -->
        <span class="ml-3 grid size-4 shrink-0 place-items-center" data-menu-icon="">
          {#if item.glyph}
            <Glyph name={item.glyph} size={16} />
          {:else if item.iconSrc}
            <img
              src={item.iconSrc}
              alt=""
              width="16"
              height="16"
              class="size-4 object-contain"
              onerror={hideBrokenIcon}
            />
          {/if}
        </span>
        <span class="ml-3 min-w-0 truncate" data-menu-label="">{item.label}</span>
        <!-- Column 4 is the shortcut column, and it is a real column: the menu is the grid, the
             rows are `subgrid`, so its width is the widest hint in THIS menu and every hint
             shares one left edge. A row without one leaves the cell empty rather than letting
             its label spill into the space, so the label column stops changing width per row.
             The grid carries no `gap` — the 12px steps are margins on the cells — so a menu
             where NO row has a shortcut (an all-registry-verbs menu) sizes that track to a true
             0px with no phantom gutter, and the reserved column costs nothing. -->
        {#if item.shortcut}<span class="text-text-secondary pl-6 text-[13px]" data-menu-hint=""
            >{item.shortcut}</span
          >{/if}
      </button>
    {/if}
  {/each}
{/snippet}

{#if menu.open}
  <div
    class="{panelClass} z-menu fixed outline-none"
    style:left="{menu.position.x}px"
    style:top="{menu.position.y}px"
    role="menu"
    tabindex="-1"
    data-menu-panel=""
    use:menu.popup
  >
    {@render rows(items, 0)}
  </div>
{/if}
