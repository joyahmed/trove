// The only place `invoke` appears for "Open with". Mirrors src-tauri/src/commands/open_with.rs.
import { invoke } from '@tauri-apps/api/core';
import type { OpenWithApp } from '$lib/types/open-with';

export const openWithApps = (path: string) => invoke<OpenWithApp[]>('open_with_apps', { path });
export const openWithApp = (id: string, paths: string[]) =>
  invoke<void>('open_with_app', { id, paths });
export const openWithDialog = (path: string) => invoke<void>('open_with_dialog', { path });
