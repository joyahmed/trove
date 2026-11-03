// The only place `invoke` appears for the Recycle Bin. Mirrors src-tauri/src/commands/recycle.rs.
import { invoke } from '@tauri-apps/api/core';
import type { RecycleItem } from '$lib/types/recycle';

export const recycleList = () => invoke<RecycleItem[]>('recycle_list');
export const recycleRestore = (ids: string[]) => invoke<void>('recycle_restore', { ids });
export const recyclePurge = (ids: string[]) => invoke<void>('recycle_purge', { ids });
export const recycleEmpty = () => invoke<void>('recycle_empty');

/** A shell folder Trove does not show (`::{…}` other than This PC and the bin, `shell:…`). */
export const openInExplorer = (arg: string) => invoke<void>('open_in_explorer', { arg });
