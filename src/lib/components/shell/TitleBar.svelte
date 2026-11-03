<script lang="ts">
  import { useTitleBar } from '$lib/hooks/use-title-bar.svelte';
  import Menu from '$lib/components/ui/Menu.svelte';
  import TabStrip from './shell-parts/TabStrip.svelte';
  import CaptionButtons from './shell-parts/CaptionButtons.svelte';

  const bar = useTitleBar();
</script>

<header
  class="h-titlebar flex shrink-0 items-end"
  role="toolbar"
  tabindex="-1"
  data-tauri-drag-region
  ondblclick={bar.ondblclick}
  oncontextmenu={bar.oncontextmenu}
>
  <TabStrip />
  <div class="min-w-16 flex-1 self-stretch" data-tauri-drag-region></div>
  <CaptionButtons buttons={bar.buttons} />
</header>
<Menu menu={bar.menu} items={bar.items} />
