<!-- One job: title, thin progress bar, amount and current file, Cancel while running,
     the error when failed, what did not arrive with Retry failed, dismiss when done. -->
<script lang="ts">
  import type { Locker } from '$lib/api/lockers';
  import type { TransferRowView } from '$lib/hooks/use-transfer-panel.svelte';
  import Glyph from '$lib/components/ui/Glyph.svelte';
  import FailedList from './FailedList.svelte';

  interface Props {
    row: TransferRowView;
    oncancel: () => void;
    ondismiss: () => void;
    onretry: () => void;
    onendtask: (path: string, locker: Locker) => void;
  }
  let { row, oncancel, ondismiss, onretry, onendtask }: Props = $props();
</script>

<div class="flex flex-col gap-1">
  <div class="flex items-center gap-3">
    <div class="flex min-w-0 flex-1 flex-col gap-1">
      <div class="flex items-baseline gap-2">
        <span class="truncate text-sm">{row.title}</span>
        {#if row.error}
          <span class="text-critical truncate">{row.error}</span>
        {:else if row.running}
          <span class="text-text-secondary">{row.amount}</span>
          <span class="text-text-secondary truncate">{row.current}</span>
        {/if}
      </div>
      <div class="bg-subtle-selected h-1 w-full overflow-hidden rounded-xs">
        <div
          class="h-full {row.error
            ? 'bg-critical'
            : row.cancelled
              ? 'bg-text-secondary'
              : 'bg-accent'}"
          style:width="{row.percent}%"
        ></div>
      </div>
    </div>
    <!-- The one "×" of every progress row (copy, move, compress, extract). A native `title` did not
         show on the Ubuntu build, so the label is drawn here: it appears on hover and on keyboard
         focus, and the same words are the accessible name. -->
    <div class="group relative shrink-0">
      <button
        type="button"
        class="rounded-control hover:bg-subtle-hover grid size-7 place-items-center"
        aria-label={row.actionLabel}
        onclick={row.running ? oncancel : ondismiss}
      >
        <Glyph name="close" size={10} />
      </button>
      <span
        class="rounded-control border-divider bg-flyout shadow-flyout z-infotip pointer-events-none absolute right-0 bottom-full mb-1 hidden border px-2 py-1 whitespace-nowrap group-focus-within:block group-hover:block"
        role="tooltip"
      >
        {row.actionLabel}
      </span>
    </div>
  </div>
  {#if !row.running && row.failed.length > 0}
    <FailedList
      failed={row.failed}
      more={row.moreFailed}
      canRetry={row.canRetry}
      {onretry}
      {onendtask}
    />
  {/if}
</div>
