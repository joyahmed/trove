// The facts Rust injects about the OS Trove runs on (`core/shell.rs`, `platform_init_script`),
// set on `window` before any page script runs. Its own module so both `platform.ts` and
// `state/coming-from.svelte.ts` can read it without importing each other (plan 19, 1.1.2).
// Off Tauri (tests, a plain browser) nothing is set and every caller treats that as Windows.

export interface TrovePlatform {
  os: string;
  thisPcLabel: string;
  /** which store this build ships through (`core/channel.rs`); absent in an older build */
  channel?: 'direct' | 'msstore';
  /** whether this build updates itself (`core/channel.rs` UPDATER, plan 22.5); absent = no */
  updater?: boolean;
  /** whether this build reads RAR (cargo feature `rar`, plan 16 phase 5); absent = no */
  rar?: boolean;
}

declare global {
  interface Window {
    __TROVE_PLATFORM__?: TrovePlatform;
  }
}

/** What Rust injected, or `undefined` off Tauri. Read at call time, never cached. */
export const injected = (): TrovePlatform | undefined =>
  typeof window === 'undefined' ? undefined : window.__TROVE_PLATFORM__;
