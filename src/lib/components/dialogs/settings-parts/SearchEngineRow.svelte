<!-- A web search engine picker: Google, Bing, DuckDuckGo, or "Custom…" with an address of your
     own. The address needs http(s) and %s (where the search words go); a bad one is refused
     with the reason under the box and nothing is saved. -->
<script lang="ts">
  import { SEARCH_ENGINES, type RadioOption } from '$lib/data/settings-sections';
  import RadioRow from './RadioRow.svelte';

  interface Props {
    options: RadioOption[];
    value: string;
    label: string;
    onchange: (template: string) => string | null;
  }
  let { options, value, label, onchange }: Props = $props();

  const CUSTOM = 'custom';
  const named = $derived(SEARCH_ENGINES.find((e) => e.template === value)?.key ?? null);
  let customOpen = $state(false);
  let draft = $state('');
  let error = $state<string | null>(null);
  const selected = $derived(customOpen || !named ? CUSTOM : named);

  const pick = (key: string) => {
    error = null;
    if (key === CUSTOM) {
      customOpen = true;
      draft = named ? '' : value;
      return;
    }
    customOpen = false;
    const engine = SEARCH_ENGINES.find((e) => e.key === key);
    if (engine) onchange(engine.template);
  };

  const apply = () => {
    error = onchange(draft);
    if (!error) customOpen = false;
  };
</script>

<div class="flex min-w-0 flex-col items-end gap-2">
  <RadioRow
    options={[...options, { key: CUSTOM, label: 'Custom…' }]}
    value={selected}
    {label}
    onchange={pick}
  />
  {#if selected === CUSTOM}
    <form
      class="flex w-full max-w-md items-center gap-2"
      onsubmit={(e) => {
        e.preventDefault();
        apply();
      }}
    >
      <input
        type="text"
        autocorrect="off"
        autocapitalize="off"
        spellcheck="false"
        autocomplete="off"
        class="rounded-control border-divider bg-surface h-8 min-w-0 flex-1 border px-2 text-sm"
        placeholder="https://example.com/search?q=%s"
        aria-label="{label} address"
        aria-invalid={error ? 'true' : undefined}
        bind:value={draft}
      />
      <button
        type="submit"
        class="rounded-control border-divider hover:bg-subtle-hover h-8 shrink-0 border px-3 text-sm"
        >Use</button
      >
    </form>
    {#if error}
      <div class="text-critical text-xs" role="alert">{error}</div>
    {/if}
  {/if}
</div>
