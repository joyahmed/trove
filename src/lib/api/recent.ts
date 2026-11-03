// The only place `invoke` appears for the recent domain. Mirrors src-tauri/src/commands/recent.rs.
import { invoke } from '@tauri-apps/api/core';
import type { FileEntry } from '$lib/types/fs';

/** The OS's recent files, newest first, files only: Windows' `Recent\*.lnk` shortcuts resolved, or Linux's `recently-used.xbel`. */
export const recentFiles = () => invoke<FileEntry[]>('recent_files');
