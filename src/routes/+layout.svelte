<script lang="ts">
  import '../app.css';
  import { useTheme } from '$lib/hooks/use-theme.svelte';
  import { useComingFrom } from '$lib/hooks/use-coming-from.svelte';
  import { blockBrowserKeys } from '$lib/utils/browser-keys';
  import { trackKeyboardModality } from '$lib/utils/keyboard-modality';
  import { bindTextUndo } from '$lib/utils/text-undo';
  import { guardTooltips } from '$lib/utils/tooltip-guard';

  let { children } = $props();

  useTheme();
  useComingFrom();

  // WebView2's own shortcuts (reload, find, print�) off in every window, explorer and Spotlight
  $effect(() => blockBrowserKeys());
  $effect(() => trackKeyboardModality());
  // WebKitGTK binds no key to a text field's undo; Linux only (utils/text-undo)
  $effect(() => bindTextUndo());
  // no native path tooltip on top of an open context menu
  $effect(() => guardTooltips());
</script>

{@render children()}
