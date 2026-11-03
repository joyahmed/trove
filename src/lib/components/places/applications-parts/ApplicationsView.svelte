<!-- Applications: every app the machine can start, the palette's APPS list as tiles (plan 17.2).
     Type to filter, arrows move, Enter or a double-click starts, F5 reloads.
     ⛔ Read-only: no Delete, Rename, Cut or drop target anywhere in this view (plan 17, traps). -->
<script lang="ts">
  import { useApplicationsView } from '$lib/hooks/use-applications-view.svelte';
  import Menu from '$lib/components/ui/Menu.svelte';
  import ApplicationTile from './ApplicationTile.svelte';

  const view = useApplicationsView();
</script>

<div
  class="flex min-h-0 min-w-0 flex-1 flex-col overflow-auto px-5 pt-2 text-xs outline-none"
  role="listbox"
  aria-label="Applications"
  tabindex="0"
  onkeydown={view.onkeydown}
  use:view.track
>
  <div class="flex h-10 shrink-0 items-center">
    <input
      class="rounded-control border-divider bg-surface placeholder:text-text-secondary h-7 w-64 max-w-full border px-2 text-xs"
      type="text"
      autocorrect="off"
      autocapitalize="off"
      spellcheck="false"
      autocomplete="off"
      placeholder="Filter apps"
      aria-label="Filter apps"
      value={view.filter}
      oninput={(e) => view.oninput(e.currentTarget.value)}
    />
  </div>
  {#if view.error}
    <p class="text-text-secondary flex items-center justify-center gap-2 p-6 text-sm" role="alert">
      <span>Couldn’t read your apps.</span>
      <button class="hover:bg-subtle-selected rounded-xs px-2 py-1 underline" onclick={view.retry}
        >Try again</button
      >
    </p>
  {:else if view.loading && view.count === 0}
    <p class="text-text-secondary p-6 text-center text-sm">Looking for your apps…</p>
  {:else if !view.loading && view.count > 0 && view.shown.length === 0}
    <p class="text-text-secondary p-6 text-center text-sm">No app matches “{view.filter}”.</p>
  {/if}
  <div class="flex flex-wrap gap-1 pb-3">
    {#each view.shown as app, i (app.lnkPath || app.aumid || app.path || app.name)}
      <ApplicationTile
        {app}
        selected={i === view.index}
        onselect={() => view.select(i)}
        onstart={() => void view.start(app)}
        oncontextmenu={(e) => view.oncontextmenu(app, i, e)}
      />
    {/each}
  </div>
  <Menu menu={view.menu} items={view.items} />
</div>
