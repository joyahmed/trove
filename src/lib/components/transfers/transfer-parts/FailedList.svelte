<!-- What a finished job could not carry: the first few by name with a short reason (full path
     on hover), "+N more", and Retry failed, which sends just those again. An item a program
     holds open names the program instead, with End task (plan 21B). -->
<script lang="ts">
  import type { Locker } from '$lib/api/lockers';
  import type { FailedItemView } from '$lib/hooks/use-transfer-panel.svelte';

  interface Props {
    failed: FailedItemView[];
    more: number;
    /** false: no Retry failed (an archive job's entries cannot be re-sent) */
    canRetry: boolean;
    onretry: () => void;
    /** End task on the program holding `path` */
    onendtask: (path: string, locker: Locker) => void;
  }
  let { failed, more, canRetry, onretry, onendtask }: Props = $props();
</script>

<div class="flex items-start gap-3">
  <ul class="flex min-w-0 flex-1 flex-col">
    {#each failed as item (item.path)}
      <li class="flex min-w-0 items-baseline gap-2" title={item.path}>
        <span class="shrink-0 truncate">{item.name}</span>
        <span class="text-text-secondary truncate">{item.locked?.message ?? item.reason}</span>
        {#if item.locked?.locker}
          {@const locker = item.locked.locker}
          <button
            type="button"
            class="rounded-control hover:bg-subtle-hover active:bg-subtle-pressed h-6 shrink-0 px-2"
            onclick={() => onendtask(item.path, locker)}
          >
            End task
          </button>
        {/if}
      </li>
    {/each}
    {#if more > 0}
      <li class="text-text-secondary">+{more} more</li>
    {/if}
  </ul>
  {#if canRetry}
    <button
      type="button"
      class="rounded-control hover:bg-subtle-hover active:bg-subtle-pressed h-7 shrink-0 px-2.5"
      onclick={onretry}
    >
      Retry failed
    </button>
  {/if}
</div>
