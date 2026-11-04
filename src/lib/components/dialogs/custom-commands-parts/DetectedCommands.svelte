<!-- The apps this machine could actually run, offered as one click each.
     ⛔ Nothing here adds itself. Detection reports; the person decides. That is why this is a
     list of buttons and not a "we set these up for you" notice.

     ⚠️ It is CAPPED, because this strip grows and the list below it does not: the catalogue went
     4 → 9 apps in one night with more queued, and an uncapped strip pushed the person's own
     commands — the actual subject of this dialog — off the bottom.

     ⛔ The cap USED to be a third of the dialog, and a percentage was the wrong shape: it scales,
     so a dialog twice as tall still hid the same fraction of the strip. It is now the room that
     is LEFT OVER once the header, the buttons and three rows of the person's own list are paid
     for — an absolute 285px reserve, so every pixel the dialog gains goes to the strip and the
     list's floor is the same three rows it always had. At the old 880 × 560 the two rules agree
     to the pixel (170px, two tile rows); at 1920 × 1080 and above the strip needs no scrollbar at
     all. Within that bound it is still clamped DOWN to a whole number of tile rows (see the rule
     on the `<section>`), so the edge never cuts a card in half. The fold is a convenience on top
     of the bound, not the bound itself, which is why it starts open.

     Every tile is exactly two lines — a label and one caption — so a row can never have one tile
     standing taller than its neighbours. Anything that would wrap truncates and keeps its full
     text in the tooltip. -->
<script lang="ts">
  import type { Suggestion } from '$lib/state/customize.svelte';
  import type { DetectedApp } from '$lib/types/shell-verbs';
  import { DETECT_EVIDENCE } from '$lib/data/detect-evidence';
  import Glyph from '$lib/components/ui/Glyph.svelte';

  interface Props {
    suggestions: Suggestion[];
    detecting: boolean;
    onadd: (found: DetectedApp) => void;
  }
  let { suggestions, detecting, onadd }: Props = $props();

  /**
   * It opens showing its tiles, because the height cap above is what protects the list and a
   * bound is better than a hiding place. The fold is here so the person can hand the whole box
   * back to their own commands when they are working in it.
   */
  let open = $state(true);

  /**
   * One line, always. The "you have one like this" clause used to be a second caption, and that
   * one tile then stood a line taller than every other tile on its row — the visible seam in the
   * strip. It is still *shown* rather than hidden, because the command the person already has may
   * well be the broken one; it is just shown on the same line.
   */
  const caption = ({ found, similar }: Suggestion) =>
    similar
      ? `${DETECT_EVIDENCE[found.source]} · you have one like this`
      : DETECT_EVIDENCE[found.source];
</script>

{#if detecting}
  <p class="text-text-secondary mb-3 shrink-0">Looking for apps you have…</p>
{:else if suggestions.length > 0}
  <!-- The height is a WHOLE NUMBER OF TILE ROWS, never a fraction of one, so the bottom edge
       always lands between cards instead of slicing through a card's border. The arithmetic only
       works because every part of this box has a height it is *told*, not one it happens to
       have: `h-10` header, 1px section border top and bottom, `h-14` tiles, `gap-2` between
       rows. That is 42px of chrome and a 64px row pitch, and `round(down, …, 64px)` takes the
       most rows that fit inside the bound.

       The bound is `100% - 285px`, and 285 is every other thing in the dialog, measured: 50px of
       header + 16 below it, 12 below this strip, 16 + 32 for the button row, and 159 — three
       53px rows — as the floor the person's own list is never pushed under. `100%` resolves
       against the dialog's content box, so the reserve is absolute and the strip takes ALL of
       any height the dialog gains. With the cap and the 42px chrome folded together that is
       `100% - 327px` inside the `round()`.

       ⚠️ The grid's `pb-2` IS in the sum, unlike the `pb-3` it replaced — but only because it
       now equals the row gap. Padding-bottom on a scroll container is scroll-end slack, not
       scrollport; n rows of 56 with 8px gaps measure 64n − 8, so 8px of trailing padding lands
       the content end exactly on the n × 64 scrollport and a strip that fits shows NO scrollbar.
       At 12px it overshot by 4 and a strip with room to spare still grew a thumb. The scrollport
       is still n × 64 either way — n rows and the gap that follows the last one — so the edge
       falls in clear space.

       `max-h-[max(106px,calc(100%-285px))]` stays on the class as the fallback: if a webview
       ever fails to parse `round()` the inline rule is dropped and the strip is still bounded by
       the same reserve, just sliced again — which is the failure we can live with. Note the row
       pitch is the same whether the grid is one column or two, because the tiles have a fixed
       height; only the tile *count* per row changes, so both column counts need one rule, not
       two. -->
  <section
    class="border-divider rounded-control mb-3 flex max-h-[max(106px,calc(100%-285px))] min-h-0 shrink-0 flex-col border"
    style="max-height: max(106px, calc(42px + round(down, 100% - 327px, 64px)))"
  >
    <h3 class="shrink-0">
      <button
        type="button"
        class="rounded-control hover:bg-subtle-hover flex h-10 w-full items-center gap-2 px-3 text-left"
        aria-expanded={open}
        onclick={() => (open = !open)}
      >
        <Glyph name={open ? 'chevronDownSmall' : 'chevronRight'} size={10} />
        <span class="font-semibold">Add one you have</span>
        <span
          class="border-divider text-text-secondary rounded-full border px-2 text-xs leading-5"
          aria-hidden="true">{suggestions.length}</span
        >
        <span class="text-text-secondary truncate text-xs">
          {open ? 'detected on this machine' : 'detected on this machine — show them'}
        </span>
      </button>
    </h3>
    {#if open}
      <div class="@container min-h-0 [scrollbar-gutter:stable] overflow-auto px-3 pb-2">
        <div class="grid grid-cols-1 gap-2 @xl:grid-cols-2">
          {#each suggestions as suggestion (suggestion.found.id)}
            {@const found = suggestion.found}
            <button
              type="button"
              data-tile
              class="rounded-control border-divider hover:bg-subtle-hover flex h-14 min-w-0 flex-col items-start gap-0.5 border px-3 py-2 text-left"
              onclick={() => onadd(found)}
            >
              <span class="flex w-full min-w-0 items-center gap-2">
                <span class="truncate">{found.label}</span>
                {#if !found.certain}
                  <!-- The one claim we must not overstate: Windows cannot see inside a distro. -->
                  <span
                    class="border-divider text-text-secondary ml-auto shrink-0 rounded-full border px-1.5 text-[10px] leading-4"
                    title="Detected by guesswork — check it works">?</span
                  >
                {/if}
              </span>
              <span class="text-text-secondary w-full truncate text-xs" title={caption(suggestion)}
                >{caption(suggestion)}</span
              >
            </button>
          {/each}
        </div>
      </div>
    {/if}
  </section>
{/if}
