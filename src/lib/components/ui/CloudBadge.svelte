<!-- Explorer's OneDrive status, drawn over an icon's bottom-right corner (the link arrow has the
     left): a cloud outline for online-only, a filled green check for "always on this device", an
     outlined check for on this device. The parent must be `relative`. Sized like LinkBadge. -->
<script lang="ts">
  import type { CloudState } from '$lib/types/fs';
  import { cloudStates } from '$lib/data/cloud-states';

  interface Props {
    state: CloudState;
    /** the icon it sits on */
    size: number;
  }
  let { state, size }: Props = $props();
  const badge = $derived(Math.max(9, Math.round(size * (size > 48 ? 0.25 : 0.56))));
</script>

<svg
  width={badge}
  height={badge}
  viewBox="0 0 10 10"
  role="img"
  aria-label={cloudStates[state].label}
  class="pointer-events-none absolute right-0 bottom-0"
  data-cloud={state}
>
  {#if state === 'online'}
    <path
      d="M2.9 8.3h4.4a1.9 1.9 0 0 0 .3-3.8 2.6 2.6 0 0 0-5-.2 2 2 0 0 0 .3 4z"
      fill="var(--color-flyout)"
      stroke="var(--color-accent)"
      stroke-width="1.1"
      stroke-linejoin="round"
    />
  {:else}
    <circle
      cx="5"
      cy="5"
      r="4.3"
      fill={state === 'pinned' ? 'var(--color-synced)' : 'var(--color-flyout)'}
      stroke="var(--color-synced)"
      stroke-width="1.1"
    />
    <path
      d="M3 5.1l1.4 1.4L7 3.9"
      fill="none"
      stroke={state === 'pinned' ? 'var(--color-flyout)' : 'var(--color-synced)'}
      stroke-width="1.3"
      stroke-linecap="round"
      stroke-linejoin="round"
    />
  {/if}
</svg>
