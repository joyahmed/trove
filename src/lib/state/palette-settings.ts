// The Spotlight window's settings: who wins between a live change and a file read.
//
// The Spotlight window (`palette`) has no shell, never `load`s and never saves. It learns
// settings two ways:
// - live: the `settings:changed` event every other window emits the moment it changes a field;
// - the file: settings.json, re-read on mount and every time the window is shown.
// ⚠️ The file can be older than the live value. The explorer writes it `SAVE_DELAY_MS` (400 ms)
// after a change, so a re-read in that window returns the OLD theme — and before this rule it
// was applied over the live one: Spotlight opened in the old theme (Mac, 2026-10-06).
//
// The rule: the newest change wins, never a stale file. A field heard live is held until a file
// read returns that same value (the file has caught up); until then the file's value for it is
// ignored. Every writer of settings.json emits `settings:changed` before it writes, so a held
// field is always released by the write that follows it. Reads that finish out of order are
// dropped too: only a read issued after the last one applied counts.
import { isRecord, sanitize, SETTINGS_KEYS, type Settings } from '$lib/state/settings.svelte';

/** What this needs of `settings`: read it whole, and set fields on it. */
export interface SettingsTarget {
  snapshot(): Settings;
  settled: boolean;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export class PaletteSettings {
  #target: SettingsTarget;
  /** fields heard live that the file has not been seen to hold yet */
  #held: Partial<Record<keyof Settings, unknown>> = {};
  #issued = 0;
  #applied = 0;

  constructor(target: SettingsTarget) {
    this.#target = target;
  }

  #set(values: Partial<Settings>) {
    const self = this.#target as unknown as Record<string, unknown>;
    const now = this.#target.snapshot() as unknown as Record<string, unknown>;
    for (const [key, value] of Object.entries(values)) {
      // assigning an equal copy would still wake everything that reads the field
      if (!same(now[key], value)) self[key] = value;
    }
    this.#target.settled = true;
  }

  /** Another window changed these fields (the `settings:changed` patch): apply them now. */
  live(raw: unknown) {
    if (!isRecord(raw)) return;
    const keys = SETTINGS_KEYS.filter((k) => k in raw);
    if (keys.length === 0) return;
    const clean = sanitize({ ...this.#target.snapshot(), ...raw });
    const values: Partial<Record<keyof Settings, unknown>> = {};
    for (const key of keys) {
      values[key] = clean[key];
      this.#held[key] = clean[key];
    }
    this.#set(values as Partial<Settings>);
  }

  /**
   * Start a file read: returns the function to call with what it returned. A read that was
   * overtaken by a later one already applied does nothing.
   */
  beginRead(): (raw: unknown) => void {
    const ticket = ++this.#issued;
    return (raw) => {
      if (ticket < this.#applied) return;
      this.#applied = ticket;
      const file = sanitize(raw) as unknown as Record<string, unknown>;
      for (const key of Object.keys(this.#held) as (keyof Settings)[]) {
        if (same(file[key], this.#held[key])) delete this.#held[key];
        else file[key] = this.#held[key];
      }
      this.#set(file as unknown as Settings);
    };
  }

  /** Fields still held over the file — for tests. */
  get held(): (keyof Settings)[] {
    return Object.keys(this.#held) as (keyof Settings)[];
  }
}
