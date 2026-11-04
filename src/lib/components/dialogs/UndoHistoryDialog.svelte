<!-- Edit ▸ History (plan 08 F, out-of-order undo): the undo history newest first. Enter (or a
     click) undoes the picked entry — an older one only while no newer entry touches its files;
     ↑ ↓ Home End move the pick, Escape closes. Mounted on demand from Shell.svelte. -->
<script lang="ts">
  import { rowId, useUndoHistory } from '$lib/hooks/use-undo-history.svelte';
  import Glyph from '$lib/components/ui/Glyph.svelte';
  import HistoryRow from './undo-history-parts/HistoryRow.svelte';

  const history = useUndoHistory();
</script>

<svelte:window onkeydown={history.onkeydown} />

<div class="z-dialog fixed inset-0 grid place-items-center bg-black/40" role="presentation">
  <div
    class="bg-layer border-divider rounded-dialog shadow-flyout flex max-h-[min(640px,calc(100vh-2rem))] w-[min(560px,calc(100vw-2rem))] flex-col border p-5 text-sm outline-none"
    role="dialog"
    aria-modal="true"
    tabindex="-1"
    use:history.trap
    aria-labelledby="undo-history-title"
  >
    <div class="mb-3 flex shrink-0 items-start gap-4">
      <div class="min-w-0 flex-1">
        <h2 id="undo-history-title" class="text-lg font-semibold">Undo history</h2>
        <p class="text-text-secondary mt-0.5">
          Newest first. Enter undoes the picked action; an older one only when nothing newer touched
          its files.
        </p>
      </div>
      <button
        type="button"
        class="rounded-control hover:bg-subtle-hover grid size-7 shrink-0 place-items-center"
        title="Close"
        aria-label="Close"
        onclick={history.close}
      >
        <Glyph name="close" size={10} />
      </button>
    </div>

    {#if history.rows.length === 0}
      <div
        class="border-divider text-text-secondary rounded-control grid min-h-32 place-items-center border px-4 py-8 text-center"
      >
        Nothing to undo yet. Renames, moves, copies, deletes and new items show up here.
      </div>
    {:else}
      <div
        class="border-divider rounded-control focus-visible:outline-accent min-h-0 flex-1 overflow-y-auto border outline-offset-1"
        role="listbox"
        tabindex="0"
        aria-label="Undo history"
        aria-activedescendant={history.activeId}
        aria-busy={history.busy}
      >
        {#each history.rows as row, at (row.index)}
          <HistoryRow
            {row}
            id={rowId(row)}
            active={at === history.active}
            onpick={() => history.choose(at)}
          />
        {/each}
      </div>
    {/if}
  </div>
</div>
