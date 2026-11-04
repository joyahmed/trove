<script lang="ts">
  import { useAddressBar } from '$lib/hooks/use-address-bar.svelte';
  import { useDropTarget } from '$lib/hooks/use-drop-target.svelte';
  import Glyph from '$lib/components/ui/Glyph.svelte';
  import Menu from '$lib/components/ui/Menu.svelte';
  import { HOME_MARK, crumbTail } from '$lib/utils/location';
  import { watchCrumbFit } from '$lib/utils/crumb-fit';
  import type { Attachment } from 'svelte/attachments';

  const bar = useAddressBar();
  const drop = useDropTarget();

  /**
   * Show only crumbs that fit WHOLE: the leading ones that do not are hidden behind a "…", so
   * no crumb shows cut mid-letter beside it (the 800 px look, 2026-10-06). Re-fitted on
   * resize, on a path change and when a web font lands — `utils/crumb-fit.ts`.
   */
  const fitCrumbs: Attachment<HTMLElement> = (row) => watchCrumbFit(row);
</script>

<!-- The separator after crumb `left`: a button that lists that folder's subfolders (plan 06 § 6.4,
     Explorer's chevron). Before the first crumb, or after a place or an archive, there is nothing
     to list and it stays a plain glyph. -->
{#snippet chevron(left: number)}
  {#if bar.canListCrumb(left)}
    {@const name = bar.crumbs[left]?.label === HOME_MARK ? 'Home' : bar.crumbs[left]?.label}
    <button
      type="button"
      class="rounded-control hover:bg-subtle-hover active:bg-subtle-pressed mx-0.5 grid h-6 w-4 shrink-0 place-items-center {bar.crumbMenuOf ===
      left
        ? 'bg-subtle-selected'
        : ''}"
      title="Folders in {name}"
      aria-label="Folders in {name}"
      aria-haspopup="menu"
      aria-expanded={bar.crumbMenuOf === left}
      data-menu-toggle
      data-crumb-chevron
      onmousedown={(e) => e.preventDefault()}
      onclick={(e) => bar.onCrumbChevron(left, e)}
    >
      <Glyph
        name={bar.crumbMenuOf === left ? 'chevronDown' : 'chevronRight'}
        size={9}
        class="text-text-secondary"
      />
    </button>
  {:else}
    <Glyph name="chevronRight" size={9} class="text-text-secondary mx-1.5 shrink-0" />
  {/if}
{/snippet}

<!-- The path ribbon (plan 12 G.1): 36px, rounded, an icon for where the path lives, then the
     crumbs — `~` for the user's home. Chevron separators, not `/`: on Windows a `/` between
     `C:` and `Users` reads as a path nobody can paste. -->
<div
  class="rounded-card border-field-stroke bg-field flex h-9 min-w-40 flex-[1_1_280px] items-center border px-1 text-sm"
  data-address-bar
  {@attach bar.historyTarget}
>
  {#if bar.editing}
    <input
      class="h-full w-full bg-transparent px-2 outline-none"
      type="text"
      autocorrect="off"
      autocapitalize="off"
      autocomplete="off"
      spellcheck="false"
      bind:value={bar.draft}
      onkeydown={bar.onkeydown}
      onblur={bar.cancel}
      use:bar.focus
    />
  {:else}
    <div
      class="flex h-full flex-1 items-center overflow-hidden"
      role="presentation"
      onclick={bar.startEdit}
    >
      <Glyph name={bar.glyph} size={16} class="mx-2 shrink-0" />
      <!-- Crumbs keep their names. A short path starts at the left; a long one drops its leading
           crumbs WHOLE behind a "…", so the current folder stays in view and nothing shows cut. -->
      <div class="flex min-w-0 flex-1 items-center overflow-hidden" {@attach fitCrumbs}>
        <span
          data-crumb-more
          class="text-text-secondary shrink-0 pr-0.5 pl-1"
          style="display: none"
          aria-hidden="true">…</span
        >
        {#each bar.crumbs as crumb, i (crumb.key)}
          <!-- the last crumb (where you are) may shrink: alone and still too wide, its name ends
               in "…" instead of being cut mid-letter -->
          {@const last = i === bar.crumbs.length - 1}
          <span data-crumb class="flex items-center {last ? 'min-w-0' : 'shrink-0'}">
            {#if crumb.sepBefore}
              {@render chevron(i - 1)}
            {/if}
            <button
              type="button"
              title={last ? crumb.label : undefined}
              class="rounded-control hover:bg-subtle-hover px-2 py-0.5 whitespace-nowrap {last
                ? 'min-w-0 truncate'
                : 'shrink-0'} {crumb.location.kind === 'path' &&
              drop.isTarget(crumb.location.path, 'crumb')
                ? 'bg-subtle-selected outline-accent outline-1'
                : ''}"
              data-drop={crumb.location.kind === 'path' ? crumb.location.path : undefined}
              data-drop-kind="crumb"
              aria-label={crumb.label === HOME_MARK ? 'Home' : undefined}
              onclick={(e) => {
                e.stopPropagation();
                void bar.go(crumb.location);
              }}>{crumb.label}</button
            >
          </span>
        {/each}
        {#if crumbTail()}
          <span data-crumb-tail class="flex shrink-0">
            {@render chevron(bar.crumbs.length - 1)}
          </span>
        {/if}
      </div>
    </div>
  {/if}
  <!-- Explorer's ▾: the places this tab has been. Windows style only, like the crumb tail; F4
       and Alt+↓ open the same list in every style. -->
  {#if crumbTail()}
    <button
      type="button"
      class="rounded-control hover:bg-subtle-hover active:bg-subtle-pressed grid size-7 shrink-0 place-items-center"
      title="Recent locations"
      aria-label="Recent locations"
      aria-haspopup="menu"
      data-menu-toggle
      aria-expanded={bar.historyMenu.open}
      onmousedown={(e) => e.preventDefault()}
      onclick={bar.onHistoryClick}
    >
      <Glyph name="chevronDown" size={12} class="text-text-secondary" />
    </button>
  {/if}
</div>

<Menu menu={bar.historyMenu} items={bar.historyItems} />
<Menu menu={bar.crumbMenu} items={bar.crumbItems} />
