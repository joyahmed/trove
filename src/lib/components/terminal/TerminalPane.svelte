<!-- The terminal pane: a header (folder, follow toggle, restart, close) over the wterm emulator.
     Lazy-loaded by TerminalHost; this is the only component that imports @wterm. -->
<script lang="ts">
  import { Terminal } from '@wterm/svelte';
  import '@wterm/svelte/css';
  import './terminal-light.css';
  import './terminal-dark.css';
  import { useTerminalPane } from '$lib/hooks/use-terminal-pane.svelte';
  import Glyph from '$lib/components/ui/Glyph.svelte';

  const pane = useTerminalPane();
</script>

<div class="flex h-8 shrink-0 items-center gap-3 px-3 text-xs">
  <Glyph name="terminal" size={14} />
  <span class="truncate" title={pane.path}>{pane.folderLabel}</span>
  {#if pane.status}<span class="text-text-secondary truncate">{pane.status}</span>{/if}
  <div class="flex-1"></div>
  <label class="flex items-center gap-1.5" title={pane.followNote}>
    <input type="checkbox" bind:checked={pane.follow} />
    Follow folder
  </label>
  {#if pane.exited}
    <button
      type="button"
      class="rounded-control hover:bg-subtle-hover px-2 py-0.5"
      onclick={pane.restart}>Restart</button
    >
  {/if}
  <button
    type="button"
    class="rounded-control hover:bg-subtle-hover grid size-6 place-items-center"
    title="Close terminal"
    aria-label="Close terminal"
    onclick={pane.close}
  >
    <Glyph name="close" size={9} />
  </button>
</div>
<div class="term-host min-h-0 flex-1 overflow-hidden">
  <Terminal
    bind:this={pane.handle}
    class="h-full"
    theme={pane.theme}
    autoResize
    cursorBlink
    onReady={pane.onReady}
    onResize={pane.onResize}
    onData={pane.onData}
    onError={pane.onError}
  />
</div>

<style>
  /* Prompt icons. Starship and other Nerd Font prompts draw Powerline arrows and icons from the
     Private Use Area, which no system monospace font has, so they showed as empty boxes. The
     bundled Symbols Nerd Font Mono (MIT + per-icon-set licenses, static/fonts/*-LICENSE.txt)
     sits LAST in the stack and its unicode-range covers only those code points, so it can never
     replace a letter, and the 1.2 MB file is fetched only when the screen shows one of them.
     wterm draws rows as DOM text spans (not a canvas), so ordinary CSS font fallback applies and
     font-display: swap repaints the icons once the file arrives. This component is lazy-loaded
     with the pane, so the @font-face costs nothing until the terminal opens. */
  @font-face {
    font-family: 'Symbols Nerd Font Mono';
    font-style: normal;
    /* One weight file claimed for every weight: a bold prompt segment uses it as-is instead of
       a smeared fake bold. */
    font-weight: 100 900;
    font-display: swap;
    src:
      local('Symbols Nerd Font Mono'),
      local('SymbolsNerdFontMono-Regular'),
      url('/fonts/symbols-nerd-font-mono.woff2') format('woff2');
    /* U+F300-F385 (Font Logos, upstream "unlicensed") was cut from the file and is left out
       here, so those code points fall back to other fonts. */
    unicode-range: U+23FB-23FE, U+2B58, U+E000-F2FF, U+F386-F8FF, U+F0000-F1AFF;
  }

  /* wterm's own stack (from @wterm/dom terminal.css), unchanged, plus the symbols font. The
     wrapper class out-ranks wterm's bare `.wterm` rule whatever order the CSS loads in. */
  .term-host :global(.wterm) {
    --term-font-family:
      'Menlo', 'Consolas', 'DejaVu Sans Mono', 'Courier New', monospace, 'Symbols Nerd Font Mono';
  }
</style>
