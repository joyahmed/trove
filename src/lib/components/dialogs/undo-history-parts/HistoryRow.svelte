<!-- One undo entry in Edit ▸ History: what it did and when, and — when it cannot be undone now —
     why, in the row itself: the newer action to undo first, or the reason a restart left. -->
<script lang="ts">
  import { historyTime } from '$lib/utils/format';
  import { isDisabled, type HistoryRow } from '$lib/state/undo-history.svelte';

  interface Props {
    row: HistoryRow;
    id: string;
    active: boolean;
    onpick: () => void;
  }
  let { row, id, active, onpick }: Props = $props();
  const disabled = $derived(isDisabled(row));
</script>

<!-- the dialog's window listener owns the keys; a click only picks -->
<!-- svelte-ignore a11y_click_events_have_key_events -->
<div
  {id}
  role="option"
  tabindex="-1"
  aria-selected={active}
  aria-disabled={disabled}
  class="border-divider flex items-start gap-3 border-b px-3 py-2 last:border-b-0 {active
    ? 'bg-subtle-selected'
    : 'hover:bg-subtle-hover'} {disabled ? 'cursor-default' : 'cursor-pointer'}"
  onclick={onpick}
>
  <div class="min-w-0 flex-1">
    <div class="flex items-baseline gap-2">
      <span class="truncate font-medium {disabled ? 'text-text-disabled' : ''}">{row.title}</span>
      {#if row.newest}
        <span class="border-divider text-text-secondary shrink-0 rounded-full border px-2 text-xs"
          >latest</span
        >
      {/if}
    </div>
    {#if row.detail}
      <div class="text-text-secondary truncate text-xs">{row.detail}</div>
    {/if}
    {#if row.note}
      <div
        class="mt-0.5 text-xs {row.status === 'blocked' ? 'text-caution' : 'text-text-secondary'}"
      >
        {row.note}
      </div>
    {/if}
  </div>
  <span class="text-text-secondary shrink-0 text-xs tabular-nums">{historyTime(row.at)}</span>
</div>
