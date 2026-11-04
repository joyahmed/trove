<script lang="ts">
  import type { SidebarItem, UsageLevel } from '$lib/data/sidebar-sections';
  import Glyph from '$lib/components/ui/Glyph.svelte';

  interface Props {
    item: SidebarItem;
    active: boolean;
    /** a drag hovers it: it is the drop target */
    dragover: boolean;
    /** a node with children, unfolded */
    expanded: boolean;
    /** a child row under an expanded node */
    nested?: boolean;
    onselect: () => void;
    /** the chevron was clicked (nodes with children only) */
    ontoggle: () => void;
    oncontextmenu: (e: MouseEvent) => void;
    /** the hover X on a pinned row */
    onunpin?: () => void;
  }
  let {
    item,
    active,
    dragover,
    expanded,
    nested = false,
    onselect,
    ontoggle,
    oncontextmenu,
    onunpin,
  }: Props = $props();

  /** neutral until the drive is getting full: colour only when it has something to say */
  // the row truncates a long name, so the tooltip is the one place it reads in full: name, drive
  // letter, then how full it is ("Video Archive (V:) — 366 GB free of 931 GB")
  const tip = $derived(
    [
      item.tag ? `${item.label} (${item.tag})` : item.label,
      item.usage?.caption,
      item.status?.label,
      item.unreachable ? 'did not answer lately' : undefined,
      item.running ? 'running' : undefined,
    ]
      .filter(Boolean)
      .join(' — '),
  );

  const FILL: Record<UsageLevel, string> = {
    ok: 'bg-text-secondary/55',
    low: 'bg-caution',
    critical: 'bg-critical',
  };
</script>

<div class="group relative mr-1 shrink-0">
  <button
    type="button"
    class="rounded-control hover:bg-subtle-hover active:bg-subtle-pressed h-navitem relative flex w-full items-center gap-3 pr-2 text-left text-sm {nested
      ? 'pl-8'
      : 'pl-3'} {active || dragover ? 'bg-subtle-selected' : ''} {dragover
      ? 'outline-accent outline-1'
      : ''} {item.unreachable ? 'text-text-disabled' : ''}"
    data-drop={item.location?.kind === 'path' ? item.location.path : undefined}
    data-drop-kind="sidebar"
    data-mac="sidebar-row"
    data-active={active}
    data-unreachable={item.unreachable || undefined}
    title={tip}
    disabled={!item.location && !item.run}
    onclick={onselect}
    {oncontextmenu}
  >
    {#if active}
      <span class="bg-accent absolute top-2 bottom-2 left-0 w-[3px] rounded-full" data-mac="sel-bar"
      ></span>
    {/if}
    {#if item.children}
      <!-- the chevron toggles; the label navigates -->
      <span
        class="grid w-3 place-items-center transition-transform {expanded ? 'rotate-90' : ''}"
        role="button"
        tabindex="-1"
        aria-expanded={expanded}
        aria-label={expanded ? 'Collapse' : 'Expand'}
        onclick={(e) => {
          e.stopPropagation();
          ontoggle();
        }}
        onkeydown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.stopPropagation();
            ontoggle();
          }
        }}
      >
        <Glyph name="chevronRight" size={9} />
      </span>
    {:else}
      <span class="grid w-3 place-items-center">
        {#if item.expandable}<Glyph name="chevronRight" size={9} />{/if}
      </span>
    {/if}
    <Glyph name={item.glyph} size={16} color={item.color} class="mac-sidebar-icon" />
    <!-- the label truncates and the tag keeps its width: rows are one fixed height. A drive's
         usage bar hangs 3px under its own text column (label start to tag end), never under the
         icon or out to the panel edge; the label and bar centre as one block on the icon. -->
    <span class="flex min-w-0 flex-1 flex-col">
      <span class="flex min-w-0 items-baseline gap-2 {item.usage ? 'leading-4' : ''}">
        <span class="min-w-0 flex-1 truncate">{item.label}</span>
        {#if item.tag}<span class="text-text-secondary shrink-0 text-xs">{item.tag}</span>{/if}
        {#if item.running}
          <span
            class="bg-running size-1.5 shrink-0 self-center rounded-full"
            data-running
            aria-hidden="true"
          ></span>
        {/if}
        {#if item.status}<Glyph
            name={item.status.glyph}
            size={12}
            color={item.status.color}
            class="self-center"
          />{/if}
      </span>
      {#if item.usage}
        <span class="bg-text-secondary/15 mt-[3px] h-[2px] overflow-hidden rounded-full">
          <span
            class="block h-full rounded-full {FILL[item.usage.level]}"
            style:width="{Math.max(2, Math.round(item.usage.fraction * 100))}%"
          ></span>
        </span>
        <span class="sr-only">, {item.usage.caption}</span>
      {/if}
    </span>
    {#if onunpin}<span class="w-5 shrink-0"></span>{/if}
  </button>
  {#if onunpin}
    <button
      type="button"
      class="rounded-control hover:bg-subtle-hover text-text-secondary absolute top-1/2 right-1 grid size-5 -translate-y-1/2 place-items-center opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
      aria-label="Unpin {item.label} from sidebar"
      title="Unpin from sidebar"
      onclick={onunpin}
    >
      <Glyph name="close" size={10} />
    </button>
  {/if}
</div>
