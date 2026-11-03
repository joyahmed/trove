// The only place `invoke` appears for the shell domain. Mirrors src-tauri/src/commands/shell.rs.
import { invoke } from '@tauri-apps/api/core';
import type { DriveInfo, KnownFolder } from '$lib/types/shell';

export const drives = () => invoke<DriveInfo[]>('drives');
export const knownFolders = () => invoke<KnownFolder[]>('known_folders');
export const userProfile = () => invoke<string | null>('user_profile');
/** The OneDrive root when the client is set up, else null. */
export const oneDriveRoot = () => invoke<string | null>('one_drive_root');
/** Windows Terminal (or a console) at a Windows or WSL path. The command lives in commands/wsl.rs. */
export const openTerminal = (path: string) => invoke<void>('open_terminal', { path });
