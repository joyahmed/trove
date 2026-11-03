<!-- The notices, stacked bottom-right above the status bar, newest at the bottom. -->
<script lang="ts">
  import { useToasts } from '$lib/hooks/use-toasts.svelte';
  import Toast from './shell-parts/Toast.svelte';

  const toasts = useToasts();
</script>

<div
  class="z-toast pointer-events-none fixed right-4 bottom-12 flex w-[380px] max-w-[calc(100vw-32px)] flex-col gap-2"
  aria-live="polite"
>
  {#each toasts.list as notice (notice.id)}
    <Toast
      {notice}
      look={toasts.lookOf(notice)}
      onaction={() => toasts.run(notice)}
      onsecond={() => toasts.run(notice, 'second')}
      ondismiss={() => toasts.dismiss(notice)}
      onpointerenter={() => toasts.onpointerenter(notice)}
      onpointerleave={() => toasts.onpointerleave(notice)}
    />
  {/each}
</div>
