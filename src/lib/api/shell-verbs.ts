// The only place `invoke` appears for the context-menu verbs. Mirrors
// src-tauri/src/commands/shell_verbs.rs.
import { invoke } from '@tauri-apps/api/core';
import type { DetectedApp, ShellMenu, ShellVerb, VerbScope } from '$lib/types/shell-verbs';

/** Windows' registered verbs, cached per process on the Rust side; `refresh` re-reads them. */
export const shellVerbs = (refresh = false) => invoke<ShellVerb[]>('shell_verbs', { refresh });

export const runShellVerb = (key: string, scope: VerbScope, path: string) =>
  invoke<void>('run_shell_verb', { key, scope, path });

/** The common entries this machine could actually run — reports only, adds nothing. */
export const detectCommonCommands = () => invoke<DetectedApp[]>('detect_common_commands');

/**
 * The file a custom command's program would start, or null when nothing would run. Asked only by
 * the Customize form before saving; running a saved command never checks it.
 */
export const resolveCustomProgram = (program: string) =>
  invoke<string | null>('resolve_custom_program', { program });

/** A user-defined command with its arguments already expanded (utils/custom-commands). */
export const runCustomCommand = (program: string, args: string[], cwd: string) =>
  invoke<void>('run_custom_command', { program, args, cwd });

/**
 * Windows' own right-click menu (`IContextMenu`) for sibling `paths`, or for the empty space of
 * the folder `paths[0]` when `background`. `extended` is Shift: the extended verbs too.
 */
export const shellMenu = (paths: string[], background: boolean, extended: boolean) =>
  invoke<ShellMenu>('shell_menu', { paths, background, extended });

/** Run item `id` of the menu `token` named, from the folder `dir`. */
export const shellMenuInvoke = (token: number, id: number, dir: string) =>
  invoke<void>('shell_menu_invoke', { token, id, dir });
