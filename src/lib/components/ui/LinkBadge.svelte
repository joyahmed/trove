<!-- Explorer's shortcut arrow, drawn over an icon's bottom-left corner for a link: a junction, a
     symlink or a macOS alias (`FileEntry.isLink`). The parent must be `relative`. Half the icon's
     size, never under 8 px, so it reads at 16 px and does not swamp a 256 px thumbnail. -->
<script lang="ts">
  interface Props {
    /** the icon it sits on */
    size: number;
  }
  let { size }: Props = $props();
  const badge = $derived(Math.max(8, Math.round(size * (size > 48 ? 0.25 : 0.5))));
</script>

<svg
  width={badge}
  height={badge}
  viewBox="0 0 10 10"
  aria-hidden="true"
  class="pointer-events-none absolute bottom-0 left-0"
>
  <rect
    x="0.5"
    y="0.5"
    width="9"
    height="9"
    rx="1.5"
    fill="var(--color-flyout)"
    stroke="var(--color-text-secondary)"
    stroke-width="0.8"
  />
  <path
    d="M2.8 7.4C2.8 5 4 3.8 6.6 3.8M5 2.4l1.8 1.4L5 5.2"
    fill="none"
    stroke="var(--color-accent)"
    stroke-width="1.3"
    stroke-linecap="round"
    stroke-linejoin="round"
  />
</svg>
