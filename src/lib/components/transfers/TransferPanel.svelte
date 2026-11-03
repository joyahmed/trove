<!-- Running and just-finished copy / move jobs, above the status bar. Nothing when idle. -->
<script lang="ts">
  import { useTransferPanel } from '$lib/hooks/use-transfer-panel.svelte';
  import TransferRow from './transfer-parts/TransferRow.svelte';

  const panel = useTransferPanel();
</script>

{#if panel.rows.length > 0}
  <div class="border-divider flex shrink-0 flex-col gap-1 border-t px-3 py-2 text-xs" role="status">
    {#each panel.rows as row (row.jobId)}
      <TransferRow
        {row}
        oncancel={() => panel.cancel(row.jobId)}
        ondismiss={() => panel.dismiss(row.jobId)}
        onretry={() => panel.retry(row.jobId)}
        onendtask={(path, locker) => panel.endTask(row.jobId, path, locker)}
      />
    {/each}
  </div>
{/if}
