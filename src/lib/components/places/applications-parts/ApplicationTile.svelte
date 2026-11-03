<!-- One app in the Applications place: its icon and name. Double-click or Enter starts it;
     right-click offers Start (Open in Mac or Linux style) / Open file location / Copy path. ⛔ Not draggable and no drop
     target: this place is read-only (plan 17, traps). -->
<script lang="ts">
  import type { AppEntry } from '$lib/types/palette';
  import { appIcon, appTileSrc } from '$lib/utils/app-icon'; // URL formatters, not IPC calls
  import { TILE_PX } from '$lib/hooks/use-applications-view.svelte';
  import Glyph from '$lib/components/ui/Glyph.svelte';

  interface Props {
    app: AppEntry;
    selected: boolean;
    onselect: () => void;
    onstart: () => void;
    oncontextmenu: (e: MouseEvent) => void;
  }
  let { app, selected, onselect, onstart, oncontextmenu }: Props = $props();

  const icon = $derived(appIcon(app));
  // a 503 or a missing icon draws the app glyph, never a broken-image box
  let failedFor = $state('');
  // one code path with Spotlight: `appTileSrc` goes through `keyedIcon` (Mac `.app` = QuickLook thumb)
  const src = $derived(
    !icon.iconKey || failedFor === icon.iconKey ? '' : appTileSrc(icon.iconKey).src,
  );
</script>

<!-- Keyboard is handled once by the list container (use-applications-view). -->
<!-- svelte-ignore a11y_click_events_have_key_events -->
<div
  class="rounded-card hover:bg-subtle-hover active:bg-subtle-pressed flex h-[96px] shrink-0 flex-col items-center justify-center gap-2 px-2"
  class:bg-subtle-selected={selected}
  style:width="{TILE_PX}px"
  role="option"
  aria-selected={selected}
  tabindex="-1"
  title={app.target || app.path || app.name}
  draggable="false"
  onclick={onselect}
  ondblclick={onstart}
  {oncontextmenu}
>
  <span class="grid h-8 w-8 place-items-center">
    {#if src}
      <img {src} alt="" width="32" height="32" onerror={() => (failedFor = icon.iconKey ?? '')} />
    {:else}
      <Glyph name={icon.glyph ?? 'fileApp'} size={32} />
    {/if}
  </span>
  <span class="line-clamp-2 w-full text-center leading-tight break-words">{app.name}</span>
</div>
