// How each notice kind looks: the glyph in its badge and the badge colour. The toast renders
// this table; nothing else decides colours.
import type { GlyphName } from '$lib/data/glyphs';
import type { NoticeKind } from '$lib/state/notices.svelte';

export interface NoticeLook {
  glyph: GlyphName;
  /** CSS colour of the badge circle */
  color: string;
  /** what a screen reader hears before the message */
  spoken: string;
}

export const noticeLooks: Record<NoticeKind, NoticeLook> = {
  info: { glyph: 'details', color: 'var(--color-accent)', spoken: 'Information' },
  success: { glyph: 'check', color: '#6ccb5f', spoken: 'Done' },
  warning: { glyph: 'warning', color: '#fce100', spoken: 'Warning' },
  error: { glyph: 'errorBadge', color: 'var(--color-critical)', spoken: 'Error' },
};
