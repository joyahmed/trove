<!-- "Replace or Skip Files" — Explorer's question before a paste overwrites anything. Mounted
     on demand from Shell.svelte while a paste is pending. -->
<script lang="ts">
  import { useConflictDialog } from '$lib/hooks/use-conflict-dialog.svelte';

  const dialog = useConflictDialog();
</script>

<svelte:window onkeydown={dialog.onkeydown} />

<div class="z-dialog fixed inset-0 grid place-items-center bg-black/40" role="presentation">
  <div
    class="bg-layer border-divider rounded-dialog shadow-flyout w-[420px] border p-5 text-sm outline-none"
    role="dialog"
    aria-modal="true"
    tabindex="-1"
    use:dialog.trap
    aria-labelledby="conflict-title"
  >
    <h2 id="conflict-title" class="mb-1 text-lg font-semibold">Replace or Skip Files</h2>
    <p class="text-text-secondary mb-3">{dialog.summary}</p>
    <ul class="text-text-secondary mb-4 max-h-40 overflow-auto text-xs">
      {#each dialog.names as name (name)}
        <li class="truncate">{name}</li>
      {/each}
      {#if dialog.more > 0}
        <li>+ {dialog.more} more</li>
      {/if}
    </ul>
    <div class="flex flex-col gap-1">
      {#each dialog.choices as choice (choice.key)}
        <button
          type="button"
          class="rounded-control hover:bg-subtle-hover active:bg-subtle-pressed flex flex-col items-start px-3 py-2 text-left"
          onclick={() => dialog.choose(choice.key)}
        >
          <span>{choice.label}</span>
          <span class="text-text-secondary text-xs">{choice.detail}</span>
        </button>
      {/each}
    </div>
    <div class="mt-4 flex justify-end">
      <button
        type="button"
        class="rounded-control border-divider hover:bg-subtle-hover border px-4 py-1"
        onclick={dialog.cancel}>Cancel</button
      >
    </div>
  </div>
</div>
