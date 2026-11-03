<!-- A list of folders with a remove button each and a box to add another by its full path. A bad
     path is refused with the reason under the box and nothing is saved. -->
<script lang="ts">
  interface Props {
    folders: string[];
    label: string;
    disabled?: boolean;
    onadd: (path: string) => string | null;
    onremove: (path: string) => unknown;
  }
  let { folders, label, disabled = false, onadd, onremove }: Props = $props();

  let draft = $state('');
  let error = $state<string | null>(null);

  const add = () => {
    error = onadd(draft);
    if (!error) draft = '';
  };
</script>

<div class="flex w-full min-w-0 flex-col items-end gap-2 sm:w-auto sm:max-w-md">
  {#each folders as folder (folder)}
    <div class="flex w-full min-w-0 items-center gap-2">
      <span class="min-w-0 flex-1 truncate text-sm" title={folder}>{folder}</span>
      <button
        type="button"
        class="rounded-control border-divider hover:bg-subtle-hover h-8 shrink-0 border px-3 text-sm disabled:cursor-not-allowed disabled:opacity-50"
        aria-label="Stop skipping {folder}"
        {disabled}
        onclick={() => onremove(folder)}>Remove</button
      >
    </div>
  {/each}
  <form
    class="flex w-full items-center gap-2"
    onsubmit={(e) => {
      e.preventDefault();
      add();
    }}
  >
    <input
      type="text"
      autocorrect="off"
      autocapitalize="off"
      autocomplete="off"
      spellcheck="false"
      class="rounded-control border-divider bg-surface h-8 min-w-0 flex-1 border px-2 text-sm disabled:opacity-50"
      placeholder="C:\Games"
      aria-label="{label}: add a folder"
      aria-invalid={error ? 'true' : undefined}
      {disabled}
      bind:value={draft}
    />
    <button
      type="submit"
      class="rounded-control border-divider hover:bg-subtle-hover h-8 shrink-0 border px-3 text-sm disabled:cursor-not-allowed disabled:opacity-50"
      {disabled}>Add</button
    >
  </form>
  {#if error}
    <div class="text-critical text-xs" role="alert">{error}</div>
  {/if}
</div>
