<!-- The add / edit form for one command: label, program, arguments with a placeholder legend,
     and the scopes it appears on. The draft lives in state; this is its markup. -->
<script lang="ts">
  import type { useCustomizeDialog } from '$lib/hooks/use-customize-dialog.svelte';

  interface Props {
    dialog: ReturnType<typeof useCustomizeDialog>;
  }
  let { dialog }: Props = $props();
</script>

{#if dialog.draft}
  <div class="flex flex-col gap-3">
    <label class="flex flex-col gap-1">
      <span class="text-text-secondary text-xs">Label</span>
      <input
        class="rounded-control border-field-stroke bg-field h-8 border px-2 outline-none"
        type="text"
        autocorrect="off"
        autocapitalize="off"
        autocomplete="off"
        placeholder={dialog.labelPlaceholder}
        spellcheck="false"
        bind:value={dialog.draft.label}
      />
    </label>
    <div class="flex flex-col gap-1">
      <label class="text-text-secondary text-xs" for="customize-program">Program</label>
      <input
        id="customize-program"
        class="rounded-control border-field-stroke bg-field h-8 border px-2 font-mono outline-none"
        type="text"
        autocorrect="off"
        autocapitalize="off"
        placeholder="code"
        spellcheck="false"
        autocomplete="off"
        role="combobox"
        aria-autocomplete="list"
        aria-controls={dialog.appListId}
        aria-expanded={dialog.appMatches.length > 0}
        aria-activedescendant={dialog.activeMatch >= 0
          ? `${dialog.appListId}-${dialog.activeMatch}`
          : undefined}
        bind:value={dialog.draft.program}
        onkeydown={dialog.programKeydown}
      />
      <ul
        id={dialog.appListId}
        role="listbox"
        aria-label="Installed apps"
        class="border-divider bg-layer rounded-control max-h-56 overflow-y-auto border"
        class:hidden={dialog.appMatches.length === 0}
      >
        {#each dialog.appMatches as m, i (m.app.aumid || m.app.path || m.app.name)}
          <!-- the keys live on the combobox input (arrows + Enter), as the ARIA combobox pattern
               has it; a row only takes the mouse, and never takes focus away from the input -->
          <!-- svelte-ignore a11y_click_events_have_key_events -->
          <li
            id={`${dialog.appListId}-${i}`}
            role="option"
            aria-selected={i === dialog.activeMatch}
            aria-disabled={m.blocked !== null}
            title={m.blocked ?? m.where}
            class="flex items-center gap-2 px-2 py-1"
            class:bg-subtle-hover={i === dialog.activeMatch}
            class:opacity-50={m.blocked !== null}
            class:cursor-pointer={m.blocked === null}
            onmousedown={(e) => e.preventDefault()}
            onclick={() => dialog.pickApp(m.app)}
          >
            {#if m.icon}
              <img class="size-4 shrink-0" src={m.icon} alt="" />
            {:else}
              <span class="size-4 shrink-0"></span>
            {/if}
            <span class="flex min-w-0 flex-col">
              <span class="truncate">{m.app.name}</span>
              <span class="text-text-secondary truncate text-xs">{m.blocked ?? m.where}</span>
            </span>
          </li>
        {/each}
      </ul>
      {#if dialog.programCheck?.kind === 'missing'}
        <span class="text-critical text-xs" role="alert">{dialog.programCheck.message}</span>
      {:else if dialog.programCheck?.kind === 'found'}
        <span class="text-text-secondary font-mono text-xs break-all" title="What Save would run"
          >{dialog.programCheck.commandLine}</span
        >
      {/if}
    </div>
    <label class="flex flex-col gap-1">
      <span class="text-text-secondary text-xs">Arguments</span>
      <input
        class="rounded-control border-field-stroke bg-field h-8 border px-2 font-mono outline-none"
        type="text"
        autocorrect="off"
        autocapitalize="off"
        autocomplete="off"
        placeholder={dialog.argsPlaceholder}
        spellcheck="false"
        bind:value={dialog.draft.args}
      />
    </label>
    <dl class="text-text-secondary grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
      {#each dialog.placeholders as p (p.token)}
        <dt class="font-mono">{p.token}</dt>
        <dd>{p.means}</dd>
      {/each}
    </dl>
    <fieldset class="flex flex-wrap gap-4">
      <legend class="text-text-secondary mb-1 text-xs">Show on</legend>
      {#each dialog.scopeOptions as option (option.key)}
        <label class="flex items-center gap-1.5">
          <input
            type="checkbox"
            checked={dialog.hasScope(option.key)}
            disabled={option.readOnly}
            onchange={() => dialog.toggleScope(option.key)}
          />
          {option.label}
        </label>
      {/each}
    </fieldset>
    <div class="mt-2 flex justify-end gap-2">
      <button
        type="button"
        class="rounded-control border-divider hover:bg-subtle-hover h-8 border px-4"
        onclick={dialog.cancelEdit}>Cancel</button
      >
      <button
        type="button"
        class="rounded-control bg-accent text-accent-text h-8 px-4 hover:opacity-90 disabled:opacity-50"
        disabled={!dialog.draftValid}
        onclick={dialog.save}>Save</button
      >
    </div>
  </div>
{/if}
