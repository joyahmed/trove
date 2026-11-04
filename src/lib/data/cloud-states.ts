// What each OneDrive (Cloud Files) state means, in plain words: the infotip's Status line, the
// badge's screen-reader label and the row menu's two items all read it from here (plan 05 5.4).
import type { GlyphName } from '$lib/data/glyphs';
import type { CloudState, SyncStatus } from '$lib/types/fs';

export interface CloudStateInfo {
  /** the short word, as Explorer's Status column says it */
  label: string;
  /** one sentence a person who has never heard "placeholder" understands */
  hint: string;
}

export const cloudStates: Record<CloudState, CloudStateInfo> = {
  online: { label: 'Online only', hint: 'Online only: it downloads when you open it' },
  pinned: { label: 'Always on this device', hint: 'Always on this device, even offline' },
  local: { label: 'On this device', hint: 'On this device: Free up space can put it back online' },
};

/** The infotip's Status text, or null for a file no cloud provider marked. */
export const cloudStateText = (state: CloudState | undefined): string | null =>
  state ? cloudStates[state].hint : null;

/** A sync root's state as a small glyph after the sidebar label, and the words its tooltip adds. */
export interface SyncStatusInfo {
  glyph: GlyphName;
  /** a token, never a literal: the glyph follows the theme */
  color: string;
  label: string;
}

export const syncStatuses: Record<SyncStatus, SyncStatusInfo> = {
  'up-to-date': { glyph: 'check', color: 'var(--color-synced)', label: 'Up to date' },
  syncing: { glyph: 'refresh', color: 'var(--color-accent)', label: 'Syncing' },
  offline: {
    glyph: 'cloud',
    color: 'var(--color-text-secondary)',
    label: 'Offline: changes sync when it reconnects',
  },
  error: { glyph: 'errorBadge', color: 'var(--color-critical)', label: 'Sync has a problem' },
};
