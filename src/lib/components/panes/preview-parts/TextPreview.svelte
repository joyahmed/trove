<!-- The head of a text file, monospace; says so when cut at 64 KB or when the file is binary. -->
<script lang="ts">
  import type { TextHead } from '$lib/types/preview';

  interface Props {
    head: TextHead | null;
    loading: boolean;
    error: string | null;
  }
  let { head, loading, error }: Props = $props();
</script>

{#if error}
  <p class="text-text-secondary py-6 text-center text-sm">{error}</p>
{:else if loading || head === null}
  <p class="text-text-secondary py-6 text-center text-sm">Loading…</p>
{:else if head.binary}
  <p class="text-text-secondary py-6 text-center text-sm">Binary file — no preview available.</p>
{:else}
  <pre
    class="font-mono text-xs leading-4 break-words whitespace-pre-wrap select-text">{head.text}</pre>
  {#if head.truncated}
    <p class="text-text-secondary mt-3 text-xs">Showing the first 64 KB.</p>
  {/if}
{/if}
