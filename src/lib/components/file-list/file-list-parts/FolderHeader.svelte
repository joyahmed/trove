<!-- Above the list: the folder's name in the serif face, its path / count / size in mono, and the
     Group and Sort pills. Fixed height and outside the scroll box, so the virtual rows never move. -->
<script lang="ts">
  import { useFolderHeader } from '$lib/hooks/use-folder-header.svelte';
  import Menu from '$lib/components/ui/Menu.svelte';

  const header = useFolderHeader();
  const pill = 'rounded-control hover:bg-subtle-hover border-divider border px-3 py-1 text-xs';
</script>

{#if header.visible}
  <div class="flex h-20 shrink-0 items-end gap-4 pr-6 pb-3 pl-1">
    <div class="min-w-0 flex-1">
      <h1 class="truncate text-[28px] leading-10 font-semibold tracking-tight" title={header.title}>
        {header.title}
      </h1>
      <p class="text-text-secondary flex font-mono text-[11px]" title={header.meta}>
        <span class="min-w-0 truncate">{header.path}</span>
        <span class="shrink-0 whitespace-pre">{` · ${header.counts}`}</span>
      </p>
    </div>
    <div class="flex shrink-0 gap-2">
      <button
        type="button"
        class={pill}
        aria-haspopup="menu"
        aria-expanded={header.groupExpanded}
        onclick={header.openGroup}>Group</button
      >
      <button
        type="button"
        class={pill}
        aria-haspopup="menu"
        aria-expanded={header.sortExpanded}
        onclick={header.openSort}>Sort</button
      >
    </div>
  </div>
  <Menu menu={header.menu} items={header.items} />
{/if}
