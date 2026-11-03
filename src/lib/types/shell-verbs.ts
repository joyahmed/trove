// Mirrors src-tauri/src/core/shell_verbs.rs (serde camelCase / kebab-case). Change both or
// neither.

/** The registry class a verb was registered on; Explorer shows each on a different target. */
export type VerbScope = 'directory' | 'directory-background' | 'file' | 'drive';

export interface ShellVerb {
  /** the registry subkey name, e.g. `VSCode` */
  key: string;
  /** what the menu shows, accelerators stripped */
  label: string;
  /** Explorer's command template, unexpanded */
  command: string;
  /** the `Icon` value (`path,index`) when the verb has one */
  icon: string | null;
  scope: VerbScope;
}

/** Where a user-defined command appears. `wsl` = only on paths inside a WSL distro. */
export type CommandScope = 'file' | 'folder' | 'background' | 'wsl';

/**
 * How a common command was found, worst to best evidence. Shown in the dialog, because
 * "we found Code" and "we guessed where Zed usually lives" are not the same claim.
 */
export type DetectSource =
  'app-paths' | 'start-menu' | 'path' | 'known-dir' | 'wsl-probe' | 'desktop-entry';

/** A ready-made entry `detect_common_commands` offers; adding it is still the person's click. */
export interface DetectedApp {
  id: string;
  label: string;
  program: string;
  args: string;
  scope: CommandScope[];
  source: DetectSource;
  /** false when the detection is a heuristic worth sanity-checking — the WSL one always is */
  certain: boolean;
}

export interface CustomCommand {
  id: string;
  label: string;
  program: string;
  /** one line; placeholders `%path%` `%paths%` `%parent%` `%name%` `%linuxpath%` `%distro%` */
  args: string;
  scope: CommandScope[];
}
