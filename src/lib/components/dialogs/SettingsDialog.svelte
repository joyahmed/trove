<!-- Settings: a section list on the left, that section's rows on the right, from
     data/settings-sections. Mounted on demand from Shell.svelte.

     ⭐ THE WIDTH GROWS WITH THE WINDOW, THE HEIGHT DOES NOT, and that asymmetry is measured, not
     a taste. Headless at 880 wide the six sections want 235 / 271 / 169 / 96 / 149 / 76 px of
     content, and the worst case anywhere in the data — Quick access with all six default folders
     unpinned — wants 414. The pane offers 510. So nothing here has ever scrolled, and every
     pixel of extra HEIGHT is dead space: at 560 the emptiest section (Advanced) already shows
     434px of nothing. Height therefore stays at the 560 it was, and only the clamp moves it.
     WIDTH is the axis the content actually wants: from 880 to 1000 the row descriptions stop
     wrapping and Behaviour drops 271 → 255, Appearance 169 → 129. Past 1000 it buys nothing but
     room, which is the thing a 2560-wide screen has and this box was refusing to take.
     `min(1120px, max(880px, 62vw))` is that: never narrower than the 880 it was, 62% of the
     window through the middle, and 1120 at the top — 44% of a 2560 screen, a big dialog and
     still unmistakably a dialog rather than a sheet.

     ⛔ The `max-` pair is the floor behaviour and must stay: `grid place-items-center` pins the
     left edge at 0 once the box is wider than the window and throws the whole overflow off the
     right, so at the 800×500 minimum window the close ×, the radios and every toggle were
     off-screen and unclickable. `max-w/max-h: calc(100vw/vh - 2rem)` is the clamp — the same one
     CustomCommandsDialog uses — and the panel's own `overflow-auto` takes it from there. -->
<script lang="ts">
  import { useSettingsDialog } from '$lib/hooks/use-settings-dialog.svelte';
  import Glyph from '$lib/components/ui/Glyph.svelte';
  import SettingRow from './settings-parts/SettingRow.svelte';

  const dialog = useSettingsDialog();
</script>

<svelte:window onkeydown={dialog.onkeydown} />

<div class="z-dialog fixed inset-0 grid place-items-center bg-black/40" role="presentation">
  <div
    class="settings-dialog bg-layer border-divider rounded-dialog shadow-flyout flex h-[560px] max-h-[calc(100vh-2rem)] w-[min(1120px,max(880px,62vw))] max-w-[calc(100vw-2rem)] overflow-hidden border text-sm outline-none"
    role="dialog"
    aria-modal="true"
    tabindex="-1"
    use:dialog.trap
    aria-labelledby="settings-title"
  >
    <nav class="settings-nav bg-mica border-divider flex w-[200px] shrink-0 flex-col border-r p-3">
      <h2 id="settings-title" class="settings-nav-title mb-3 px-2 text-lg font-semibold">
        Settings
      </h2>
      {#each dialog.sections as section (section.key)}
        <button
          type="button"
          class="settings-nav-item rounded-control hover:bg-subtle-hover relative h-9 px-3 text-left {dialog.current ===
          section.key
            ? 'bg-subtle-selected'
            : ''}"
          data-section={section.key}
          aria-current={dialog.current === section.key ? 'page' : undefined}
          onclick={() => dialog.select(section.key)}
        >
          {#if dialog.current === section.key}
            <span
              class="settings-nav-marker bg-accent absolute top-2 bottom-2 left-0 w-[3px] rounded-full"
            ></span>
          {/if}
          {section.label}
        </button>
      {/each}
    </nav>
    <div class="settings-content flex min-w-0 flex-1 flex-col">
      <div class="settings-header flex items-center px-6 pt-5">
        <h3 class="settings-title text-base font-semibold">{dialog.title}</h3>
        <div class="flex-1"></div>
        <button
          type="button"
          class="settings-close rounded-control hover:bg-subtle-hover grid size-7 place-items-center"
          title="Close"
          aria-label="Close"
          onclick={dialog.close}
        >
          <Glyph name="close" size={10} />
        </button>
      </div>
      <div class="settings-body min-h-0 flex-1 overflow-auto px-6 pb-6">
        <!-- `settings-group` is a hook for the Mac look (styles/mac/settings.css) and nothing else:
             an unstyled block, so on Windows and Linux the rows lay out exactly as before. -->
        <div class="settings-group">
          {#each dialog.rows as row (row.key)}
            <SettingRow {row} />
          {/each}
        </div>
      </div>
    </div>
  </div>
</div>
