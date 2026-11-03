<!-- One notice, Win11 InfoBar style: a coloured badge, a title and message, one or two
     actions, a close button. Slides in from the right; the clock pauses while hovered. -->
<script lang="ts">
  import type { NoticeLook } from '$lib/data/notice-kinds';
  import type { Notice } from '$lib/state/notices.svelte';
  import Glyph from '$lib/components/ui/Glyph.svelte';
  import { inBinWords } from '$lib/utils/platform';

  interface Props {
    notice: Notice;
    look: NoticeLook;
    onaction: () => void;
    /** the second button (End task beside Retry) */
    onsecond: () => void;
    ondismiss: () => void;
    onpointerenter: () => void;
    onpointerleave: () => void;
  }
  let { notice, look, onaction, onsecond, ondismiss, onpointerenter, onpointerleave }: Props =
    $props();
</script>

<div
  class="toast bg-flyout border-divider rounded-card shadow-flyout pointer-events-auto flex gap-3 border p-3 text-sm"
  role={notice.kind === 'error' ? 'alert' : 'status'}
  {onpointerenter}
  {onpointerleave}
>
  <span
    class="mt-0.5 grid size-5 shrink-0 place-items-center rounded-full text-black"
    style:background={look.color}
    title={look.spoken}
  >
    <Glyph name={look.glyph} size={11} />
  </span>
  <div class="flex min-w-0 flex-1 flex-col gap-1">
    {#if notice.title}<span class="font-semibold">{notice.title}</span>{/if}
    <span class="text-text-secondary break-words">{inBinWords(notice.message)}</span>
    {#if notice.action || notice.second}
      <div class="mt-1 flex gap-2">
        {#if notice.action}
          <button
            type="button"
            class="bg-accent text-accent-text rounded-control h-8 px-3 hover:opacity-90"
            onclick={onaction}>{notice.action.label}</button
          >
        {/if}
        {#if notice.second}
          <button
            type="button"
            class="rounded-control border-divider hover:bg-subtle-hover active:bg-subtle-pressed h-8 border px-3"
            onclick={onsecond}>{notice.second.label}</button
          >
        {/if}
      </div>
    {/if}
  </div>
  <button
    type="button"
    class="hover:bg-subtle-hover rounded-control grid size-7 shrink-0 place-items-center"
    title="Dismiss"
    aria-label="Dismiss"
    onclick={ondismiss}
  >
    <Glyph name="close" size={10} />
  </button>
</div>

<style>
  /* the slide-in: a keyframe is the one thing the utilities cannot say */
  .toast {
    animation: toast-in 150ms ease-out;
  }
  @keyframes toast-in {
    from {
      opacity: 0;
      transform: translateX(16px);
    }
    to {
      opacity: 1;
      transform: none;
    }
  }
  /* Animation effects off: the notice just appears (app.css zeroes durations too; this keeps
     the slide off even if that rule is ever weakened) */
  @media (prefers-reduced-motion: reduce) {
    :global(:root:not([data-reduced-motion])) .toast {
      animation: none;
    }
  }
  /* Linux writes the live answer on <html> (app.css, core/reduced_motion.rs); it wins there */
  :global(:root[data-reduced-motion='reduce']) .toast {
    animation: none;
  }
</style>
