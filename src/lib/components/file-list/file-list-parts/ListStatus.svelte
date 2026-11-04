<!-- Empty / error / starting / searching states of the list, in one place. -->
<script lang="ts">
  import { useListStatus } from '$lib/hooks/use-list-status.svelte';
  import EmptyState from '$lib/components/ui/EmptyState.svelte';

  const status = useListStatus();
</script>

{#snippet action(label: string, testid: string, onclick: () => void)}
  <button
    class="hover:bg-subtle-selected rounded-xs px-2 py-1 underline"
    data-testid={testid}
    {onclick}>{label}</button
  >
{/snippet}

{#if status.error}
  <EmptyState glyph="errorBadge" message={status.error} tone="critical" testid="list-error">
    {#if status.canSignIn}
      {@render action('Sign in…', 'list-error-sign-in', status.signIn)}
    {/if}
    {#if status.unreachable}
      {@render action('Try again', 'list-error-retry', status.retry)}
    {/if}
  </EmptyState>
{:else if status.reaching}
  <EmptyState
    glyph="folder"
    message="Still reaching {status.reaching}…"
    testid="list-reaching"
    live
  >
    {@render action('Cancel', 'list-reaching-cancel', status.cancel)}
  </EmptyState>
{:else if status.starting}
  <EmptyState glyph="linux" message="Starting {status.starting}…" />
{:else if status.searching}
  <EmptyState glyph="search" message={status.searching} />
{:else if status.empty}
  <EmptyState glyph="folder" message={status.emptyText} />
{/if}
