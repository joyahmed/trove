<script lang="ts">
  import { useShell } from '$lib/hooks/use-shell.svelte';
  import TitleBar from './TitleBar.svelte';
  import NavBar from '$lib/components/nav/NavBar.svelte';
  import Sidebar from '$lib/components/sidebar/Sidebar.svelte';
  import FileList from '$lib/components/file-list/FileList.svelte';
  import PlaceView from '$lib/components/places/PlaceView.svelte';
  import GalleryView from '$lib/components/places/gallery-parts/GalleryView.svelte';
  import { folderGallerySource } from '$lib/hooks/use-gallery-view.svelte';
  import TransferPanel from '$lib/components/transfers/TransferPanel.svelte';
  import PaneHost from '$lib/components/panes/PaneHost.svelte';
  import TerminalHost from '$lib/components/terminal/TerminalHost.svelte';
  import StatusBar from './StatusBar.svelte';
  import Toasts from './Toasts.svelte';

  const shell = useShell();
</script>

<svelte:window
  onkeydown={shell.onkeydown}
  oncontextmenu={shell.oncontextmenu}
  onmouseup={shell.onmouseup}
/>

<!--
  ⭐ THE WINDOW FRAME IS THIS DIV. On Windows and Linux no window asks the OS for a backdrop, so
  `bg-mica` is what the title and nav rows sit on (on a Mac the window has the system's `sidebar`
  glass behind it and app.css turns this fill into a see-through tint — `data-os`), and `rounded-window` + `overflow-hidden` is the whole rounded frame —
  14px, which DWM cannot give us at all (it offers ROUND ~8px or ROUNDSMALL ~4px and nothing else).
  ⛔ The fill belongs HERE and never on `body`: a body background propagates to the viewport canvas,
  which is square and unclippable, and painting it there measurably cuts the arc back to 10px. The
  long version is in `app.css` on the html/body rule.
  ⚠️ `overflow-hidden` is what makes the arc clip its children; the dialogs and their skeletons are
  `position: fixed` SIBLINGS of this div, and nothing here establishes a containing block for them,
  so no overlay is clipped by it.
-->
<div class="bg-mica text-text rounded-window flex h-screen flex-col overflow-hidden">
  <!-- Two chrome rows, not Explorer's three (plan 12 G.1): the title/tabs row and one toolbar. -->
  <TitleBar />
  <NavBar />
  <div class="bg-layer flex min-h-0 flex-1 flex-col">
    <div class="flex min-h-0 flex-1">
      <Sidebar />
      {#if shell.showList}
        <FileList />
      {:else if shell.showFolderGallery}
        <GalleryView source={folderGallerySource} />
      {:else}
        <PlaceView />
      {/if}
      <PaneHost />
    </div>
    <TerminalHost />
    <TransferPanel />
    <StatusBar status={shell.status} selected={shell.selected} />
  </div>
  <Toasts />
</div>

<!-- A yes/no question (Shift+Delete) is rare: mounted only while one is pending (CONTRIBUTING § 5). -->
{#if shell.confirm}
  {#await shell.lazyDialog(import('$lib/components/dialogs/ConfirmDialog.svelte'), shell.giveUp.confirm)}
    <div class="z-dialog-urgent fixed inset-0 grid place-items-center bg-black/40">
      <div
        class="bg-layer border-divider rounded-dialog shadow-flyout flex w-[420px] flex-col gap-3 border p-5"
      >
        <div class="bg-subtle-selected h-6 w-1/2 rounded-xs"></div>
        <div class="bg-subtle-selected h-4 w-full rounded-xs"></div>
        <div class="bg-subtle-selected ml-auto h-8 w-40 rounded-xs"></div>
      </div>
    </div>
  {:then { default: ConfirmDialog }}
    <ConfirmDialog />
  {:catch}
    <!-- the chunk did not load: the question was given up (use-shell lazyDialog) -->
  {/await}
{/if}

<!-- The person's own context-menu commands: edited rarely, mounted only while open.
     ⚠️ The size rule is COPIED from CustomCommandsDialog's list view, not invented here: a
     skeleton that is not the size of the thing it resolves into is a jump, not a placeholder.
     Change it there and change it here. -->
{#if shell.customizing}
  {#await shell.lazyDialog(import('$lib/components/dialogs/CustomCommandsDialog.svelte'), shell.giveUp.customize)}
    <div class="z-dialog-nested fixed inset-0 grid place-items-center bg-black/40">
      <div
        class="bg-layer border-divider rounded-dialog shadow-flyout flex h-[min(800px,max(560px,66vh))] max-h-[calc(100vh-2rem)] w-[min(1120px,max(880px,62vw))] max-w-[calc(100vw-2rem)] flex-col gap-3 border p-5"
      >
        <div class="bg-subtle-selected h-6 w-1/2 rounded-xs"></div>
        <div class="bg-subtle-selected h-4 w-full rounded-xs"></div>
        <div class="bg-subtle-selected h-24 w-full shrink-0 rounded-xs"></div>
        <div class="bg-subtle-selected min-h-0 flex-1 rounded-xs"></div>
        <div class="bg-subtle-selected h-8 w-40 rounded-xs"></div>
      </div>
    </div>
  {:then { default: CustomCommandsDialog }}
    <CustomCommandsDialog />
  {:catch}
    <!-- the chunk did not load: the question was given up (use-shell lazyDialog) -->
  {/await}
{/if}

<!-- The conflict question is rare: mounted only while a paste waits on it (CONTRIBUTING § 5). -->
{#if shell.conflict}
  {#await shell.lazyDialog(import('$lib/components/dialogs/ConflictDialog.svelte'), shell.giveUp.conflict)}
    <div class="z-dialog fixed inset-0 grid place-items-center bg-black/40">
      <div
        class="bg-layer border-divider rounded-dialog shadow-flyout flex w-[420px] flex-col gap-3 border p-5"
      >
        <div class="bg-subtle-selected h-6 w-2/3 rounded-xs"></div>
        <div class="bg-subtle-selected h-4 w-full rounded-xs"></div>
        <div class="bg-subtle-selected h-4 w-5/6 rounded-xs"></div>
      </div>
    </div>
  {:then { default: ConflictDialog }}
    <ConflictDialog />
  {:catch}
    <!-- the chunk did not load: the question was given up (use-shell lazyDialog) -->
  {/await}
{/if}

<!-- Settings: a click away, never at first paint.
     ⚠️ The size rule is COPIED from SettingsDialog — width grows with the window, height does
     not. It said 720 × 520 while the dialog said 880 × 560, so the box visibly jumped as the
     lazy chunk landed. Change it there and change it here. -->
{#if shell.settingsOpen}
  {#await shell.lazyDialog(import('$lib/components/dialogs/SettingsDialog.svelte'), shell.giveUp.settings)}
    <div class="z-dialog fixed inset-0 grid place-items-center bg-black/40">
      <div
        class="bg-layer border-divider rounded-dialog shadow-flyout flex h-[560px] max-h-[calc(100vh-2rem)] w-[min(1120px,max(880px,62vw))] max-w-[calc(100vw-2rem)] overflow-hidden border"
      >
        <div class="bg-mica w-[200px] shrink-0 p-3">
          <div class="bg-subtle-selected mb-3 h-6 w-2/3 rounded-xs"></div>
          <div class="bg-subtle-selected mb-2 h-8 w-full rounded-xs"></div>
          <div class="bg-subtle-selected mb-2 h-8 w-full rounded-xs"></div>
          <div class="bg-subtle-selected h-8 w-full rounded-xs"></div>
        </div>
        <div class="flex flex-1 flex-col gap-3 p-6">
          <div class="bg-subtle-selected h-5 w-1/3 rounded-xs"></div>
          <div class="bg-subtle-selected h-12 w-full rounded-xs"></div>
          <div class="bg-subtle-selected h-12 w-full rounded-xs"></div>
          <div class="bg-subtle-selected h-12 w-full rounded-xs"></div>
        </div>
      </div>
    </div>
  {:then { default: SettingsDialog }}
    <SettingsDialog />
  {:catch}
    <!-- the chunk did not load: the question was given up (use-shell lazyDialog) -->
  {/await}
{/if}
