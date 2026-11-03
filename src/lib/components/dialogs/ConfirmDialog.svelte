<!-- A yes/no question (permanent delete). Mounted on demand from Shell.svelte while one is
     pending; Enter answers yes, Escape no. -->
<script lang="ts">
  import { useConfirmDialog } from '$lib/hooks/use-confirm-dialog.svelte';

  const dialog = useConfirmDialog();
</script>

<svelte:window onkeydown={dialog.onkeydown} />

<div class="z-dialog-urgent fixed inset-0 grid place-items-center bg-black/40" role="presentation">
  <div
    class="bg-layer border-divider rounded-dialog shadow-flyout w-[420px] border p-5 text-sm outline-none"
    role="alertdialog"
    aria-modal="true"
    tabindex="-1"
    use:dialog.trap
    aria-labelledby="confirm-title"
  >
    <h2 id="confirm-title" class="mb-1 text-lg font-semibold">{dialog.title}</h2>
    <p class="text-text-secondary mb-5 break-words whitespace-pre-line">{dialog.message}</p>
    <div class="flex justify-end gap-2">
      <button
        type="button"
        class="rounded-control border-divider hover:bg-subtle-hover active:bg-subtle-pressed h-8 border px-4"
        onclick={dialog.cancel}>Cancel</button
      >
      <button
        type="button"
        class="rounded-control text-accent-text h-8 px-4 hover:opacity-90 {dialog.danger
          ? 'bg-critical text-white'
          : 'bg-accent'}"
        onclick={dialog.ok}>{dialog.okLabel}</button
      >
    </div>
  </div>
</div>
