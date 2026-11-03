// The only place `invoke` appears for uninstall. Mirrors src-tauri/src/commands/uninstall.rs.
// ⛔ Tests `vi.mock` this module: no test ever reaches a real uninstaller.
import { invoke } from '@tauri-apps/api/core';
import type { UninstallOutcome, Uninstallable } from '$lib/types/uninstall';

/** What the confirm showed: Rust runs the fresh row only if it still says exactly this. */
export type Confirmed = Pick<Uninstallable, 'id' | 'name' | 'version' | 'program' | 'stamp'>;

export const uninstallList = () => invoke<Uninstallable[]>('uninstall_list');
/**
 * Rust re-lists and acts only on the fresh row `id` names, and only if its name, version,
 * program and stamp are still what the person confirmed; resolves once its uninstaller ended
 * (Windows) or the bundle went to the Trash (Mac).
 */
export const uninstallApp = ({ id, name, version, program, stamp }: Confirmed) =>
  invoke<UninstallOutcome>('uninstall_app', { id, name, version, program, stamp });
/** Settings → Installed apps, for a Store app (no Uninstall key; Settings can't jump to one app). */
export const openAppsSettings = () => invoke<void>('open_apps_settings');
